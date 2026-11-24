import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.loadEnvFile(resolve(root, '.env'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const windows = process.platform === 'win32';
const python = resolve(root, '.venv-icons', windows ? 'Scripts/python.exe' : 'bin/python');
const env = {
  ...process.env,
  HF_HOME: resolve(root, 'data/icon-models'),
  PIP_CACHE_DIR: resolve(root, 'data/pip-cache'),
};
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function startIcons(args) {
  return spawn(python, ['scripts/local-icons.py', ...args], { cwd: root, env, stdio: 'inherit' });
}

if (process.argv.includes('--setup')) {
  if (!existsSync(python))
    run(windows ? 'python' : 'python3', ['-m', 'venv', '--without-pip', '.venv-icons']);
  if (spawnSync(python, ['-m', 'pip', '--version'], { stdio: 'ignore' }).status !== 0) {
    // Bootstrap pip inside the isolated environment, including WSL installs without python3-venv.
    run(python, [
      '-c',
      'import urllib.request, tempfile, runpy, os; ' +
        'f = tempfile.NamedTemporaryFile(suffix=".py", delete=False); f.close(); ' +
        'urllib.request.urlretrieve("https://bootstrap.pypa.io/get-pip.py", f.name); ' +
        'runpy.run_path(f.name, run_name="__main__"); os.unlink(f.name)',
    ]);
  }
  run(python, [
    '-m',
    'pip',
    'install',
    'torch==2.7.1',
    '--index-url',
    'https://download.pytorch.org/whl/cu126',
  ]);
  run(python, ['-m', 'pip', 'install', '-r', 'scripts/icon-requirements.txt']);
  console.log('Local icon dependencies installed. Run npm start with GATHER_ICON_URL configured, or npm run icons for the service alone.');
} else if (process.argv[2] === '--with-game') {
  const game = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts', '--production', ...process.argv.slice(3)], {
    cwd: root, env, stdio: 'inherit',
  });
  let icons;
  if (/^http:\/\/(127\.0\.0\.1|localhost):7861\/?$/.test(env.GATHER_ICON_URL?.trim() ?? '')) {
    if (existsSync(python)) {
      icons = startIcons(['--if-not-running']);
      icons.on('error', (error) => console.error('Could not start local icons:', error.message));
    } else {
      console.warn('Local icons are not installed. Run npm run icons:setup once to enable generation.');
    }
  }
  game.on('error', (error) => console.error('Could not start Gather:', error.message));
  game.on('close', (code, signal) => {
    icons?.kill();
    process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    icons?.kill();
    game.kill(signal);
  });
} else {
  if (!existsSync(python)) {
    console.error('Run npm run icons:setup first. Python 3.11–3.13 and an NVIDIA GPU are required.');
    process.exit(1);
  }
  const child = startIcons(process.argv.slice(2));
  child.on('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
}
