import assert from 'node:assert/strict';
import { presignS3, sha256 } from '../src/services/video-studio/s3-signing.ts';
import { defaultS3Config, validateS3Config, sameS3Target, modelReadableMediaUrl, sniffUploadMedia, withoutCloudUpload } from '../src/services/video-studio/upload-contract.ts';
import { referencedStudioAssets } from '../src/services/video-studio/library.ts';
import { studioVideoMediaReferences } from '../src/services/video-studio/media.ts';
import { getVideoGenerationCapabilities } from '../src/services/providers/provider-capabilities.ts';
import { parseStudioBundle } from '../src/services/video-studio/document.ts';

const config={...defaultS3Config(),endpoint:'https://s3.us-east-1.amazonaws.com',bucket:'test-bucket'};
const credentials={accessKeyId:'AKIDEXAMPLE',secretAccessKey:'example-secret-key'},now=new Date('2026-11-16T01:02:03Z');
assert.equal(await sha256(new TextEncoder().encode('abc')),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
const signed=await presignS3(config,credentials,'folder/a b+中.mp4','GET',{now});
assert.equal(new URL(signed).pathname,'/test-bucket/folder/a%20b%2B%E4%B8%AD.mp4');
assert.ok(!signed.includes(credentials.secretAccessKey));
assert.equal(new URL(signed).searchParams.get('X-Amz-SignedHeaders'),'host');
const hostConfig={...config,endpoint:'https://s3.eu-west-1.amazonaws.com',region:'eu-west-1',pathStyle:false};
const put=await presignS3(hostConfig,{...credentials,sessionToken:'session/+ token'},'refs/a.png','PUT',{now,headers:{'Content-Type':'image/png','X-Amz-Meta-Sha256':'0'.repeat(64)}});
assert.equal(new URL(put).hostname,'test-bucket.s3.eu-west-1.amazonaws.com');
assert.equal(new URL(put).searchParams.get('X-Amz-Security-Token'),'session/+ token');
assert.equal(new URL(put).searchParams.get('X-Amz-SignedHeaders'),'content-type;host;x-amz-meta-sha256');
assert.notEqual(new URL(put).searchParams.get('X-Amz-Signature'),new URL(await presignS3(hostConfig,{...credentials,sessionToken:'session/+ token'},'refs/a.png','PUT',{now,headers:{'Content-Type':'image/jpeg','X-Amz-Meta-Sha256':'0'.repeat(64)}})).searchParams.get('X-Amz-Signature'));
const head=await presignS3(config,credentials,'folder/file.mp4','HEAD',{now});
assert.notEqual(new URL(head).searchParams.get('X-Amz-Signature'),new URL(await presignS3(config,credentials,'folder/file.mp4','GET',{now})).searchParams.get('X-Amz-Signature'));
// Fixed reference signatures are checked below, independently produced by aws4 1.13.2.
assert.deepEqual([signed,put,head].map(url=>new URL(url).searchParams.get('X-Amz-Signature')), [
  '39627f5afa0973ba7cb96f82d94385d25cdd19aa437485425e9a8b07c5314f2b',
  '0bcdb3ca7e3af60de32fbd6acbdcad814775967b7c6064551138f815359059b0',
  '7ec812cee70d06c56f9b33fa2c902facad3577821fec8c6dd51657f9d434adff',
]);
for(const broken of [
  {...config,endpoint:'http://storage.example.com'}, {...config,endpoint:'https://127.0.0.1'}, {...config,endpoint:'https://storage.example.com?token=private'},
  {...config,bucket:'../bad'}, {...config,prefix:'a/../b'}, {...config,urlLifetimeHours:169}, {...config,urlLifetimeHours:0},
]) assert.throws(()=>validateS3Config(broken));
assert.equal(sameS3Target(config,{...config,prefix:'other',urlLifetimeHours:6}),true);
assert.equal(sameS3Target(config,{...config,bucket:'different'}),false);
await assert.rejects(()=>presignS3(config,credentials,'../bad','PUT'),/object key/);
await assert.rejects(()=>presignS3(config,{...credentials,secretAccessKey:''},'a','GET'),/credentials/);
await assert.rejects(()=>presignS3(config,credentials,'a','GET',{expires:604801}),/lifetime/);
assert.equal(sniffUploadMedia(new Uint8Array([137,80,78,71,13,10,26,10]),'image').mimeType,'image/png');
assert.equal(sniffUploadMedia(new TextEncoder().encode('RIFF0000WAVE'),'audio').mimeType,'audio/wav');
assert.equal(sniffUploadMedia(new Uint8Array([0,0,0,24,...new TextEncoder().encode('ftypisom')]),'video').mimeType,'video/mp4');
assert.throws(()=>sniffUploadMedia(new Uint8Array([26,69,223,163]),'video'),/format/,'renaming WebM to .mp4 cannot bypass format checks');
assert.throws(()=>sniffUploadMedia(new Uint8Array([255,241,80,128]),'audio'),/format/,'AAC ADTS is not an MP3 frame');

const cloud={target:config,objectKey:'refs/test.mp4',url:signed,expiresAt:'2026-11-17T01:02:03Z',uploadedAt:now.toISOString(),sha256:'0'.repeat(64),sizeBytes:100};
const asset={id:'v',kind:'video',name:'Local clip',category:'reference',createdAt:now.toISOString(),url:'data:video/mp4;base64,YWJj',mimeType:'video/mp4',durationSeconds:5,cloudUpload:cloud};
assert.equal(modelReadableMediaUrl(asset,'doubao-video',now.getTime()),signed);
assert.equal(modelReadableMediaUrl(asset,'doubao-video',Date.parse(cloud.expiresAt)-60_000),undefined,'near-expiry links are blocked before model submission');
assert.equal(modelReadableMediaUrl({...asset,cloudUpload:undefined,sourceUrl:'asset://asset-example'},'doubao-video',now.getTime()),'asset://asset-example');
assert.equal(modelReadableMediaUrl({...asset,cloudUpload:undefined,sourceUrl:'asset://asset-example'},'agnes-video',now.getTime()),undefined);
assert.ok(!JSON.stringify(withoutCloudUpload({...asset,sourceUrl:signed})).includes('X-Amz-'),'media exports contain no signed upload links');
const imported=parseStudioBundle({assets:[asset],canvas:{nodes:[{id:'n',kind:'video',name:'N',x:0,y:0,prompt:'',assetId:'v'}],edges:[]}},'canvas');
assert.equal(imported.assets[0].cloudUpload,undefined,'imported media cannot claim a verified cloud upload');
assert.deepEqual([...referencedStudioAssets({canvases:[],worlds:[],commerceProjects:[],jobs:[],uploadTasks:[{assetId:'v',status:'uploading'},{assetId:'free',status:'failed'}]})],['v']);
const futureCloud={...cloud,expiresAt:new Date(Date.now()+3600_000).toISOString()};
const refs=await studioVideoMediaReferences({videoReferenceAssetIds:['v']},[{...asset,cloudUpload:futureCloud}],getVideoGenerationCapabilities('doubao-video','doubao-seedance-2-0-260128'),async()=>{throw new Error('must not encode verified cloud media as data URI');});
assert.equal(refs.videoReferences[0].url,signed);
await assert.rejects(()=>studioVideoMediaReferences({videoReferenceAssetIds:['v']},[{...asset,cloudUpload:{...cloud,expiresAt:'2020-01-01T00:00:00Z'}}],getVideoGenerationCapabilities('doubao-video'),async()=>''),/renew/);
console.log('Studio upload contracts passed: signed S3 methods, metadata binding, expiry, format checks, target isolation, package stripping and model reference selection.');
