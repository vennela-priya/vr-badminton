import fs from 'fs';

const hasCerts = fs.existsSync('./cert.key') && fs.existsSync('./cert.crt');

export default {
  // GitHub Pages serves from /vr-badminton/ in production; locally it's /
  base: process.env.NODE_ENV === 'production' ? '/vr-badminton/' : '/',

  server: {
    https: hasCerts
      ? { key: fs.readFileSync('./cert.key'), cert: fs.readFileSync('./cert.crt') }
      : undefined,
    host: true,
    port: 5173,
    hmr: {
      host: 'vennela.local',
      port: 5173,
      protocol: hasCerts ? 'wss' : 'ws',
    },
  },
};
