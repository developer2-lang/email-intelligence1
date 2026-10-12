import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

async function isBackendRunning() {
  try {
    const res = await fetch('http://localhost:5002/api/health', { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  console.log('🚀 Starting Email Intelligence dev environment...');
  let backend = null;

  const running = await isBackendRunning();
  if (running) {
    console.log('✅ Backend server is already running on http://localhost:5002');
  } else {
    console.log('📦 Starting backend server on port 5002...');
    backend = spawn('node', ['backend/server.js'], {
      cwd: rootDir,
      stdio: 'inherit',
      shell: true,
    });
  }

  console.log('🌐 Starting Vite frontend server...');
  const frontend = spawn('npx', ['vite'], {
    cwd: rootDir,
    stdio: 'inherit',
    shell: true,
  });

  function cleanup() {
    if (backend) backend.kill();
    frontend.kill();
    process.exit();
  }

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('exit', cleanup);
}

main();
