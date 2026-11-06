'use strict';
// Compile the application’s code-native SVG mark into Windows icon resources.
const fs=require('node:fs');
const path=require('node:path');
const sharp=require(process.env.LEDGER_SHARP_PATH||'sharp');
const root=path.resolve(__dirname,'..');
(async()=>{
 const source=fs.readFileSync(path.join(root,'assets/app-icon.svg'));
 await sharp(source).png().toFile(path.join(root,'assets/app-icon.png'));
 const png=await sharp(source).resize(256,256).png().toBuffer();
 const header=Buffer.alloc(22);header.writeUInt16LE(1,2);header.writeUInt16LE(1,4);header.writeUInt16LE(1,10);header.writeUInt16LE(32,12);header.writeUInt32LE(png.length,14);header.writeUInt32LE(22,18);
 fs.writeFileSync(path.join(root,'assets/app-icon.ico'),Buffer.concat([header,png]));
 console.log('Compiled native SVG app icon: PNG + ICO.');
})().catch(error=>{console.error(error.message);process.exitCode=1;});
