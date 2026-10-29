import { openConfiguredDatabase } from '../src/db.mjs';
import { config } from '../src/config.mjs';
const db=await openConfiguredDatabase(config);
console.log(await db.prepare('SELECT 1 as ok').get());
await db.close();
