// resources/media/make-ad.mjs — Instagram (1080x1920, 30 fps) ad for LiBER.
//
//   node resources/media/make-ad.mjs [out.mp4]
//   -> artifacts/media/liber-instagram-ad.mp4
//
// Everything is produced by ffmpeg's own sources: no stock footage, no assets, no
// fonts beyond Windows'. Written in JS rather than PowerShell because a filtergraph
// is one long string full of ':' and quotes — passing it as a single argv element
// avoids every layer of shell escaping.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const out = process.argv[2] || path.join('artifacts', 'media', 'liber-instagram-ad.mp4');
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
mkdirSync(path.dirname(out), { recursive: true });

const F = {
  bold: 'C\\:/Windows/Fonts/segoeuib.ttf',
  semi: 'C\\:/Windows/Fonts/seguisb.ttf',
  mono: 'C\\:/Windows/Fonts/consola.ttf'
};
const C = { gold: '0xE5B25C', cyan: '0x39C5F0', red: '0xF0616D', green: '0x2FD07A', white: '0xFFFFFF' };

const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");

/** A layer that fades in at `at` and is only drawn between at..until. */
function layer({ text, font = F.bold, size, y, color = `${C.white}@0.95`, at, until, x = '(w-text_w)/2', fade = 0.35 }) {
  return [
    `drawtext=fontfile='${font}'`,
    `text='${esc(text)}'`,
    `fontsize=${size}`,
    `fontcolor=${color}`,
    `x=${x}`,
    `y=${y}`,
    `enable='between(t,${at},${until})'`,
    `alpha='if(lt(t,${at}),0,min(1,(t-${at})/${fade}))'`
  ].join(':');
}

const panel = (x, y, w, h, color) =>
  `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${color}:t=fill:enable='between(t,7.2,14.0)'`;

const draw = [
  // Hook
  layer({ text: 'your code', size: 88, y: 820, at: 1.4, until: 4.4 }),
  layer({ text: 'just failed', size: 88, y: 926, at: 2.0, until: 4.4 }),
  layer({ text: 'again.', size: 156, y: 800, color: C.red, at: 4.4, until: 7.0 }),

  // Terminal card
  panel(90, 560, 900, 360, '0x101216@0.88'),
  panel(90, 560, 900, 2, `${C.cyan}@0.55`),
  layer({ text: '$ liber fix', font: F.mono, size: 40, color: C.cyan, x: 130, y: 606, at: 7.4, until: 14.0 }),
  layer({ text: '[E1] terminal OK (exit 0)', font: F.mono, size: 34, color: `${C.white}@0.9`, x: 130, y: 686, at: 8.6, until: 14.0 }),
  layer({ text: '[E2] file patched', font: F.mono, size: 34, color: `${C.white}@0.9`, x: 130, y: 746, at: 9.4, until: 14.0 }),
  layer({ text: 'GROUNDING PASS · 12 receipts', font: F.mono, size: 34, color: C.green, x: 130, y: 812, at: 10.6, until: 14.0 }),

  // Payoff beats over the card
  layer({ text: 'LiBER reads it.', font: F.semi, size: 56, color: `${C.white}@0.92`, y: 1000, at: 7.6, until: 9.6 }),
  layer({ text: 'fixes it.', size: 104, y: 1000, at: 9.6, until: 11.6 }),
  layer({ text: '337 tests · 0 failing', font: F.mono, size: 34, color: `${C.white}@0.8`, y: 1170, at: 9.9, until: 11.6, fade: 0.5 }),
  layer({ text: 'proves it.', size: 104, y: 1000, color: C.cyan, at: 11.6, until: 14.0 }),
  layer({ text: 'every claim on a tool receipt', font: F.mono, size: 34, color: `${C.white}@0.55`, y: 1170, at: 11.9, until: 14.0, fade: 0.5 }),

  // Wordmark
  layer({ text: 'L i B E R', size: 176, y: 806, at: 14.4, until: 20, fade: 0.5 }),
  `drawbox=x=96:y=790:w=10:h=210:color=${C.gold}@0.95:t=fill:enable='between(t,14.4,20)'`,
  `drawbox=x=974:y=790:w=10:h=210:color=${C.gold}@0.95:t=fill:enable='between(t,14.4,20)'`,
  layer({ text: 'no claim without a receipt', font: F.semi, size: 50, color: `${C.white}@0.85`, y: 1050, at: 15.4, until: 20 }),

  // CTA
  layer({ text: 'npm i -g @arthovlabs/liber', size: 46, color: C.cyan, y: 1230, at: 17.8, until: 20 }),
  layer({ text: 'autonomous engineering agent', font: F.semi, size: 44, color: `${C.white}@0.8`, y: 1310, at: 17.8, until: 20 }),
  layer({ text: 'withmerlin.online', font: F.mono, size: 34, color: `${C.white}@0.45`, y: 1780, at: 6.0, until: 20, fade: 0.8 }),
  `drawbox=x=0:y=1912:w='1080*t/20':h=8:color=${C.cyan}@0.55:t=fill`
].join(',');

const filter = [
  // procedural background: a slow, breathing gradient with a grid and vignette
  `[0:v]scale=1080:1920,zoompan=z='min(zoom+0.0005,1.10)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1080x1920:fps=30,`,
  `drawgrid=w=90:h=90:t=1:color=white@0.025,vignette=PI/5,`,
  `${draw},`,
  `fade=t=in:st=0:d=0.6,fade=t=out:st=19.75:d=0.25,format=yuv420p[v];`,
  `[1:a][2:a]amix=inputs=2:duration=longest,volume=0.12,tremolo=f=0.2:d=0.5,`,
  `afade=t=in:st=0:d=1.2,afade=t=out:st=18.4:d=1.6[a]`
].join('');

const args = [
  '-hide_banner', '-y',
  '-f', 'lavfi', '-i', 'gradients=s=1080x1920:c0=0x0B1B3A:c1=0x070A10:c2=0x151F36:n=3:speed=0.015:d=20:r=30',
  '-f', 'lavfi', '-i', 'sine=frequency=55:duration=20:sample_rate=48000',
  '-f', 'lavfi', '-i', 'sine=frequency=110:duration=20:sample_rate=48000',
  '-filter_complex', filter,
  '-map', '[v]', '-map', '[a]',
  '-t', '20',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '19', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '128k',
  '-movflags', '+faststart',
  out
];

process.stdout.write(`rendering ${out} …\n`);
const r = spawnSync(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
if (r.status !== 0) {
  process.stderr.write((r.stderr || '').split('\n').slice(-8).join('\n') + '\n');
  process.exit(r.status || 1);
}
process.stdout.write(`done: ${out}\n`);
