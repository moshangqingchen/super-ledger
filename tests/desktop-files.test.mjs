import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const {assertSafeExport}=createRequire(import.meta.url)('../desktop/fs-safety.cjs');
test('native export cannot overwrite live data or escape through a directory junction',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ledger-export-'));
  try{
    const profile=path.join(root,'profile'),documents=path.join(root,'documents');fs.mkdirSync(profile);fs.mkdirSync(documents);fs.mkdirSync(path.join(profile,'data'));
    const ledger=path.join(profile,'data','ledger.json');fs.writeFileSync(ledger,'original');
    assert.throws(()=>assertSafeExport(ledger,[profile]),/不能覆盖/);
    assert.throws(()=>assertSafeExport(path.join(profile,'data','future.json'),[profile]),/不能覆盖/);
    assert.equal(assertSafeExport(path.join(documents,'backup.json'),[profile]),path.join(fs.realpathSync.native(documents),'backup.json'));
    const link=path.join(documents,'linked-data');fs.symlinkSync(profile,link,process.platform==='win32'?'junction':'dir');
    assert.throws(()=>assertSafeExport(path.join(link,'data','ledger.json'),[profile]),/不能覆盖/);
    assert.equal(fs.readFileSync(ledger,'utf8'),'original');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
