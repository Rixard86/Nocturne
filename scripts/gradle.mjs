// Run the Gradle wrapper from the android/ project, picking the right launcher per OS
// so the same npm script works from PowerShell, Git Bash, and CI.
import { spawnSync } from 'child_process';
import { resolve } from 'path';

const isWindows = process.platform === 'win32';
const wrapper = resolve('android', isWindows ? 'gradlew.bat' : 'gradlew');
const args = process.argv.slice(2);

// On Windows a .bat needs a shell, and passing args separately alongside shell:true is
// deprecated — so the command is assembled into one quoted string instead.
const result = isWindows
  ? spawnSync(`"${wrapper}" ${args.join(' ')}`, { cwd: 'android', stdio: 'inherit', shell: true })
  : spawnSync(wrapper, args, { cwd: 'android', stdio: 'inherit' });

process.exit(result.status ?? 1);
