'use strict';
const fs=require('node:fs');
const path=require('node:path');
function canonical(filename){
  const absolute=path.resolve(filename);
  if(fs.existsSync(absolute))return fs.realpathSync.native(absolute);
  const parent=path.dirname(absolute);
  return path.join(fs.realpathSync.native(parent),path.basename(absolute));
}
function assertSafeExport(filename,protectedDirectories){
  if(typeof filename!=='string'||!path.isAbsolute(filename))throw new Error('请选择有效的导出位置');
  const target=canonical(filename);
  for(const directory of protectedDirectories){
    if(!fs.existsSync(directory))continue;
    const root=canonical(directory);
    const relative=path.relative(root,target);
    if(relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative)))throw new Error('请把备份保存到文档、桌面或其他备份目录，不能覆盖应用内部账本与配置文件。');
  }
  return target;
}
module.exports={assertSafeExport};
