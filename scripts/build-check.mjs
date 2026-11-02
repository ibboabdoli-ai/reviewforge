import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const folders=['src','api','scripts'];
let checked=0;
for (const folder of folders) {
  for (const name of readdirSync(folder).filter(n=>n.endsWith('.mjs'))) {
    const file=join(folder,name);
    const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});
    if(result.status!==0){process.stderr.write(result.stderr||`Invalid ${file}\n`);process.exit(1);}
    checked++;
  }
}
console.log(`Syntax checked ${checked} modules successfully.`);
