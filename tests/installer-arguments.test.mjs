import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

test('installer launch reads real child results and preserves spaced owner paths', {skip:process.platform !== 'win32',timeout:60000}, async t => {
  const cache = path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache', 'nsis-3.0.4.1');
  const dirs = await fs.readdir(cache, {withFileTypes:true}).catch(() => []);
  let compiler;
  for (const entry of dirs.filter(entry=>entry.isDirectory())) {
    const candidate = path.join(cache,entry.name,'Bin','makensis.exe');
    if (await fs.access(candidate).then(()=>true,()=>false)) { compiler=candidate; break; }
  }
  if (!compiler) {
    assert.notEqual(process.env.AWESOME_REQUIRE_NSIS,'1','packaging must provide the NSIS compiler for this regression');
    t.skip('Requires the NSIS compiler downloaded by npm run dist; run again after packaging.'); return;
  }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(),'awesome-installer-arguments-'));
  t.after(()=>fs.rm(temporary,{recursive:true,force:true}));
  const executable = path.join(temporary,'arguments.exe');
  await run(compiler,['/V2',`/DOUTPUT_FILE=${executable}`,path.join(root,'tests','fixtures','installer-arguments.nsi')],{windowsHide:true,timeout:10000});
  const source = await fs.readFile(path.join(root,'build','installer.nsh'),'utf8');
  const commands = [...source.matchAll(/!insertmacro AwesomeShellExecResult "runas"[^\r\n]*'([^']+)' \$0 \$1/g)].map(match=>match[1]);
  assert.equal(commands.length,2,'exercise both install and uninstall commands');
  for (const command of commands) {
    const raw = command.replaceAll('$\\"','"').replaceAll('$INSTDIR','C:\\Program Files\\Awesome Downloader');
    await run(executable,[raw],{windowsVerbatimArguments:true,windowsHide:true,timeout:5000});
  }
  const launcher = path.join(temporary,'launcher.exe');
  async function launch(child, args, legacy = false) {
    await run(compiler,['/V2',`/DOUTPUT_FILE=${launcher}`,`/DPROJECT_ROOT=${root}`,`/DCHILD_FILE=${child}`,`/DCHILD_ARGUMENTS=${args}`,...(legacy?['/DLEGACY_LAUNCH']:[]),path.join(root,'tests','fixtures','installer-launch.nsi')],{windowsHide:true,timeout:10000});
    return run(launcher,[],{windowsHide:true,timeout:5000});
  }
  // Exercise the production ShellExecuteEx/wait/GetExitCodeProcess macro.
  // "open" avoids elevation in tests; production uses the same code with "runas".
  await launch(executable,'/owner=$\\"C:\\Program Files\\Awesome Downloader$\\"');
  await assert.rejects(launch(executable,'/owner=invalid'),error=>error.code===2);
  await assert.rejects(launch(path.join(temporary,'missing.exe'),''),error=>error.code===99);
  // The previous launch instruction leaves $0 untouched even on success.
  await assert.rejects(launch(executable,'/owner=$\\"C:\\Program Files\\Awesome Downloader$\\"',true),error=>error.code===0x00070FD8);
  // Prove the regression harness rejects the exact original quoting defect.
  await assert.rejects(run(executable,['"/owner=C:\\Program Files\\Awesome Downloader"'],{windowsVerbatimArguments:true,windowsHide:true,timeout:5000}),error=>error.code===2);
});
