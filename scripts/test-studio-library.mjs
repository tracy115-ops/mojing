import assert from 'node:assert/strict';
import { assetFolderPath, folderDescendants, normalizeAssetTags, referencedStudioAssets, restoreLibraryAssets, saveLibraryFolder, trashLibraryAssets } from '../src/services/video-studio/library.ts';
import { assetBundleFolders, parseAssetBundle } from '../src/services/video-studio/asset-bundle.ts';

let folders = saveLibraryFolder([], { id:'root', name:' Characters ' });
folders = saveLibraryFolder(folders, { id:'child', name:'Costumes', parentId:'root' });
assert.equal(assetFolderPath(folders,'child'),'Characters / Costumes');
assert.deepEqual(folderDescendants(folders,'root'),['root','child']);
assert.throws(()=>saveLibraryFolder(folders,{id:'root',name:'Characters',parentId:'child'}),/cycle/);
assert.throws(()=>saveLibraryFolder(folders,{id:'other',name:'characters'}),/Duplicate/);
assert.throws(()=>saveLibraryFolder(folders,{id:'missing',name:'Folder',parentId:'unknown'}),/Invalid/);
assert.deepEqual(normalizeAssetTags([' face ','face','','costume']),['face','costume']);
assert.equal(normalizeAssetTags(Array.from({length:30},(_,i)=>'x'.repeat(50)+i)).every(tag=>tag.length<=40),true);
const asset = (id, extra={}) => ({id,name:id,kind:'text',text:'A studio note',category:'reference',createdAt:'2026-11-16',...extra});
const state = {
  assets:['free','node','params','world','commerce','draft','queued','running','completed','failed'].map(id=>asset(id,{folderId:'child',tags:['cast']})), trashedAssets:[],
  canvases:[{nodes:[{assetId:'node',generation:{audioReferenceAssetIds:['params']}}]}],
  worlds:[{objects:[{assetId:'world'}]}],commerceProjects:[{references:[{assetId:'commerce'}]}],draft:{lastFrameAssetId:'draft'},
  jobs:['queued','running','completed','failed'].map(status=>({status,input:{videoReferenceAssetIds:[status]}})),
};
assert.deepEqual([...referencedStudioAssets(state)].sort(),['commerce','draft','node','params','queued','running','world']);
const recycled=trashLibraryAssets(state,state.assets.map(a=>a.id),'2026-11-16T01:00:00Z');
assert.deepEqual(recycled.changed,['free','completed','failed']);
assert.equal(recycled.blocked.length,7);
assert.equal(state.assets.length,10,'batch recycling cannot mutate undo/persistence inputs');
assert.equal(recycled.trashedAssets[0].trashedAt,'2026-11-16T01:00:00Z');
const restored=restoreLibraryAssets({...recycled,assetFolders:folders},['free']);
assert.equal(restored.assets.find(a=>a.id==='free').folderId,'child');
assert.equal(restored.assets.find(a=>a.id==='free').trashedAt,undefined);
const missingFolder=restoreLibraryAssets({...recycled,assetFolders:[]},['free']);
assert.equal(missingFolder.assets.find(a=>a.id==='free').folderId,undefined,'restoring to a deleted folder falls back to unfiled');
assert.equal(restoreLibraryAssets({...restored,assetFolders:folders},['free']).assets.length,restored.assets.length,'restore is idempotent');

const packageData={format:'mojing.assets/1',folders,assets:[asset('note',{folderId:'child',tags:['cast']}),asset('image',{kind:'image',url:'data:image/png;base64,YWJj',folderId:'child',tags:['cast']})]};
assert.deepEqual(assetBundleFolders(packageData.assets,folders),folders,'export includes folder ancestors');
const imported=parseAssetBundle(packageData),again=parseAssetBundle(packageData);
assert.equal(imported.assets.length,2);
assert.equal(imported.assets[0].tags[0],'cast');
assert.notEqual(imported.assets[0].id,'note');
assert.notEqual(imported.assets[0].id,again.assets[0].id);
assert.notEqual(imported.assets[0].folderId,'child');
assert.ok(imported.folders.some(f=>f.id===imported.assets[0].folderId));
assert.equal(assetFolderPath(imported.folders,imported.assets[0].folderId),'Characters / Costumes');
assert.throws(()=>parseAssetBundle({...packageData,folders:[{id:'a',name:'A',parentId:'b'},{id:'b',name:'B',parentId:'a'}]}),/cyclic/);
assert.throws(()=>parseAssetBundle({...packageData,assets:[asset('remote',{kind:'video',url:'https://video.test/example.mp4'})]}),/embedded/);
assert.throws(()=>parseAssetBundle({...packageData,assets:[asset('local',{kind:'video',url:'C:/clip.mp4'})]}),/embedded/);
assert.throws(()=>parseAssetBundle({...packageData,assets:[asset('broken',{folderId:'absent'})]}),/folder/);
assert.throws(()=>parseAssetBundle({...packageData,assets:[asset('broken',{tags:[3]})]}),/tags/);
assert.throws(()=>parseAssetBundle({...packageData,assets:[packageData.assets[0],packageData.assets[0]]}),/asset/);
assert.equal(packageData.assets[0].folderId,'child','failed package imports leave the source unchanged');
console.log('Studio library contracts passed: folders, cycles, every reference guard, partial recycling, restore, portable hierarchy and atomic import.');
