// `npm start`: run the app in Electron from source. Terminals inside VS Code
// set ELECTRON_RUN_AS_NODE=1, which would make Electron act as plain Node,
// so it's cleared here first.
const { spawn } = require('child_process');
const electron = require('electron');
const path = require('path');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [path.join(__dirname, '..'), ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code == null ? 0 : code));
