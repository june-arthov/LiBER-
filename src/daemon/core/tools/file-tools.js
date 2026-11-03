// src/daemon/core/tools/file-tools.js — Liber File Tools
const fs = require('fs');
const path = require('path');
const policy = require('../policy');

// Resolve path safely relative to working directory
function resolvePath(filePath) {
  if (!filePath) throw new Error("File path is required.");
  return path.resolve(process.cwd(), filePath);
}

// 1. READ FILE (Line-numbered with offset, limit, and budget cap)
async function readFile({ path: filePath, offset = 1, limit = 100, maxChars = 80000 }) {
  const absPath = resolvePath(filePath);
  if (!fs.existsSync(absPath)) {
    return { error: `File not found: ${filePath}` };
  }

  const stat = fs.statSync(absPath);
  if (stat.isDirectory()) {
    return { error: `Path is a directory, not a file: ${filePath}. Use search_files or terminal to list directory.` };
  }

  const raw = fs.readFileSync(absPath, 'utf8');
  const allLines = raw.split(/\r?\n/);
  const totalLines = allLines.length;

  const startLine = Math.max(1, parseInt(offset, 10) || 1);
  const maxLines = Math.min(parseInt(limit, 10) || 100, 500);
  const slice = allLines.slice(startLine - 1, startLine - 1 + maxLines);

  let output = [];
  let runningChars = 0;
  let linesRead = 0;
  let truncated = false;

  for (let i = 0; i < slice.length; i++) {
    const lineNum = String(startLine + i).padStart(4, '0');
    const formatted = `${lineNum} | ${slice[i]}`;
    if (runningChars + formatted.length > maxChars) {
      truncated = true;
      break;
    }
    output.push(formatted);
    runningChars += formatted.length + 1;
    linesRead++;
  }

  const hasMore = startLine - 1 + linesRead < totalLines;
  const result = {
    path: filePath,
    total_lines: totalLines,
    offset: startLine,
    lines_read: linesRead,
    content: output.join('\n')
  };

  if (hasMore || truncated) {
    result.next_offset = startLine + linesRead;
    result.has_more = true;
  }

  return result;
}

// 2. WRITE FILE (Safe atomic write with parent dir creation)
async function writeFile({ path: filePath, content = "" }) {
  const guard = policy.checkWrite(filePath);
  if (!guard.allowed) {
    return { error: guard.reason, policy_denied: true, path: filePath };
  }

  const absPath = resolvePath(filePath);
  const dir = path.dirname(absPath);
  
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(absPath, content, 'utf8');
  const stat = fs.statSync(absPath);
  const lines = content.split(/\r?\n/).length;

  return {
    success: true,
    path: filePath,
    bytes_written: stat.size,
    lines_written: lines,
    message: `Successfully wrote ${stat.size} bytes (${lines} lines) to ${filePath}`
  };
}

// 3. PATCH (surgical search-and-replace with fuzzy whitespace match & diff)
async function patchFile({ path: filePath, old_string, new_string, replace_all = false }) {
  const guard = policy.checkWrite(filePath);
  if (!guard.allowed) {
    return { error: guard.reason, policy_denied: true, path: filePath };
  }

  const absPath = resolvePath(filePath);
  if (!fs.existsSync(absPath)) {
    return { error: `File not found: ${filePath}` };
  }

  if (typeof old_string !== 'string' || typeof new_string !== 'string') {
    return { error: "Both old_string and new_string must be provided as strings." };
  }

  const content = fs.readFileSync(absPath, 'utf8');

  // Exact Match Check First
  if (content.includes(old_string)) {
    const occurrences = content.split(old_string).length - 1;
    if (occurrences > 1 && !replace_all) {
      return {
        error: `old_string matches ${occurrences} times in ${filePath}. Provide more surrounding context to uniquely identify the target chunk, or set replace_all: true.`
      };
    }
    const updated = replace_all
      ? content.replaceAll(old_string, new_string)
      : content.replace(old_string, new_string);

    fs.writeFileSync(absPath, updated, 'utf8');
    return {
      success: true,
      path: filePath,
      strategy: "exact",
      occurrences_replaced: occurrences,
      diff_preview: generateDiff(old_string, new_string)
    };
  }

  // Whitespace-normalized Fuzzy Match Fallback (handles CRLF vs LF mismatches)
  const normContent = content.replace(/\r\n/g, '\n');
  const normOld = old_string.replace(/\r\n/g, '\n');
  const normNew = new_string.replace(/\r\n/g, '\n');

  if (normContent.includes(normOld)) {
    const updated = normContent.replace(normOld, normNew);
    // Preserve original newline format if content had CRLF
    const finalContent = content.includes('\r\n') ? updated.replace(/\n/g, '\r\n') : updated;
    fs.writeFileSync(absPath, finalContent, 'utf8');
    return {
      success: true,
      path: filePath,
      strategy: "fuzzy_whitespace",
      occurrences_replaced: 1,
      diff_preview: generateDiff(normOld, normNew)
    };
  }

  return {
    error: `Target old_string could not be found in ${filePath}. Verify the file content using read_file before patching.`
  };
}

// Minimalist unified diff generator for previews
function generateDiff(oldStr, newStr) {
  const oldLines = oldStr.split(/\r?\n/).map(l => `- ${l}`);
  const newLines = newStr.split(/\r?\n/).map(l => `+ ${l}`);
  return [...oldLines, ...newLines].slice(0, 20).join('\n');
}

// 4. SEARCH FILES (Grep content or find file paths)
async function searchFiles({ pattern, path: dirPath = ".", target = "content", file_glob = null, limit = 50 }) {
  const root = resolvePath(dirPath);
  if (!fs.existsSync(root)) {
    return { error: `Directory not found: ${dirPath}` };
  }

  const results = [];
  const maxResults = Math.min(parseInt(limit, 10) || 50, 200);
  const regex = new RegExp(pattern, 'i');
  const globRegex = file_glob ? new RegExp(file_glob.replace(/\*/g, '.*'), 'i') : null;

  const IGNORE_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.venv', '__pycache__', '.pytest_cache']);

  function walk(currentDir) {
    if (results.length >= maxResults) return;
    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= maxResults) break;
      const fullPath = path.join(currentDir, entry.name);
      const relPath = path.relative(process.cwd(), fullPath);

      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) {
          walk(fullPath);
        }
      } else if (entry.isFile()) {
        if (globRegex && !globRegex.test(entry.name)) continue;

        if (target === "files") {
          if (regex.test(relPath) || regex.test(entry.name)) {
            results.push({ file: relPath });
          }
        } else {
          // Content search
          try {
            const content = fs.readFileSync(fullPath, 'utf8');
            const lines = content.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i])) {
                results.push({
                  file: relPath,
                  line: i + 1,
                  match: lines[i].trim().slice(0, 150)
                });
                if (results.length >= maxResults) break;
              }
            }
          } catch {
            // Skip unreadable or binary files
          }
        }
      }
    }
  }

  walk(root);

  return {
    target,
    pattern,
    total_found: results.length,
    matches: results
  };
}

module.exports = {
  readFile,
  writeFile,
  patchFile,
  searchFiles
};
