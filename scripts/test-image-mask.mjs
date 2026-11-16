import assert from 'node:assert/strict';
import { compositeMaskedPixels } from '../src/services/video-studio/image-mask.ts';
import { validateStudioImageEdit } from '../src/services/video-studio/image-edit-input.ts';
import { studioInputAssetIds } from '../src/services/video-studio/media.ts';
import { referencedStudioAssets, trashLibraryAssets } from '../src/services/video-studio/library.ts';
import { createStudioCanvas, parseStudioBundle, parseStudioCanvas } from '../src/services/video-studio/document.ts';
import { getImageGenerationCapabilities, parseEndpointGenerationCapabilities } from '../src/services/providers/provider-capabilities.ts';
import { validateNativeImageEdit } from '../src/services/providers/image-edit-contract.ts';
import { buildSDWebUIRequest } from '../src/services/providers/image-wire-contract.ts';
import { buildImageRequestSnapshot } from '../src/services/providers/generation-snapshot.ts';

const source = new Uint8ClampedArray([11, 22, 33, 101, 20, 30, 40, 255, 255, 0, 0, 255, 19, 70, 99, 0]);
const candidate = new Uint8ClampedArray([200, 210, 220, 255, 80, 90, 100, 255, 0, 0, 255, 0, 20, 40, 60, 128]);
const mask = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255, 128, 128, 128, 255, 255, 255, 255, 255]);
const composed = compositeMaskedPixels(source, candidate, mask);
assert.deepEqual([...composed], [11, 22, 33, 101, 80, 90, 100, 255, 255, 0, 0, 127, 20, 40, 60, 128], 'unselected RGBA is exact; alpha edges blend without dark fringes');
assert.deepEqual([...source], [11, 22, 33, 101, 20, 30, 40, 255, 255, 0, 0, 255, 19, 70, 99, 0], 'source stays intact');
assert.deepEqual([...compositeMaskedPixels(new Uint8ClampedArray([0,0,0,255]),new Uint8ClampedArray([255,255,255,255]),new Uint8ClampedArray([128,128,128,255]))], [128,128,128,255]);
assert.throws(() => compositeMaskedPixels(source, candidate.slice(4), mask), /buffers/);
assert.throws(() => compositeMaskedPixels(source.slice(1), candidate.slice(1), mask.slice(1)), /buffers/);

const png = 'data:image/png;base64,YWJj', sd = getImageGenerationCapabilities('stable-diffusion');
const request = { taskType:'storyboard', model:'sd-inpainting', prompt:'Replace the selected object', width:160, height:96, referenceImages:[png], mask:png, editStrength:0.4 };
assert.equal(sd.references.maskSupported, true);
assert.ok(sd.parameters.some(spec => spec.key === 'editStrength'));
validateNativeImageEdit(request, sd);
assert.throws(() => validateNativeImageEdit(request, getImageGenerationCapabilities('agnes-image')), /native masks/);
assert.equal(getImageGenerationCapabilities('agnes-image', undefined, undefined, {references:{supported:true,maxImages:5,mode:'multiple',maskSupported:true}}).references.maskSupported, false, 'overrides cannot invent an adapter');
assert.ok(!getImageGenerationCapabilities('comfyui').references.maskSupported, 'default ComfyUI profile has no native workflow support');
assert.ok(getImageGenerationCapabilities('comfyui',undefined,undefined,{references:{supported:true,maxImages:1,mode:'single',maskSupported:true}}).parameters.some(spec=>spec.key==='editStrength'), 'explicit WebUI-compatible mask contracts also expose the adapter strength parameter');
assert.throws(() => validateNativeImageEdit({...request, mask:'https://example.com/mask.png'},sd), /PNG/);
assert.throws(() => validateNativeImageEdit({...request, referenceImages:[]},sd), /exactly one/);
for (const editStrength of [-0.1, 1.1, NaN]) assert.throws(() => validateNativeImageEdit({...request,editStrength},sd), /strength/);
assert.throws(() => parseEndpointGenerationCapabilities(JSON.stringify({image:{'sd-inpainting':{references:{supported:false,maxImages:0,mode:'none',maskSupported:true}}}})), /maskSupported/);
const wire = buildSDWebUIRequest(request);
assert.equal(wire.path, '/sdapi/v1/img2img');
assert.deepEqual(wire.body.init_images, [png]); assert.equal(wire.body.mask,png);
assert.equal(wire.body.denoising_strength,0.4); assert.equal(wire.body.inpainting_mask_invert,0); assert.equal(wire.body.mask_blur,0);
assert.equal(wire.body.inpaint_full_res,false); assert.equal(wire.body.include_init_images,false);
const textWire = buildSDWebUIRequest({taskType:'storyboard',prompt:'A landscape',seed:0});
assert.equal(textWire.path,'/sdapi/v1/txt2img'); assert.equal(textWire.body.seed,0); assert.ok(!('mask' in textWire.body)); assert.ok(!('init_images' in textWire.body));
const imgWire = buildSDWebUIRequest({...request,mask:undefined,editStrength:undefined});
assert.equal(imgWire.body.denoising_strength,0.65); assert.ok(!('mask' in imgWire.body));
assert.throws(()=>buildSDWebUIRequest({...request,referenceImages:[]}),/source/);
const snapshot=buildImageRequestSnapshot(request,['model','editStrength'],[],buildSDWebUIRequest(request,true).body);
assert.equal(snapshot.referenceSlots.length,2); assert.equal(snapshot.referenceSlots[1].id,'image-edit-mask');
assert.ok(snapshot.referenceSlots[1].payloadFingerprint); assert.ok(!JSON.stringify(snapshot).includes('YWJj'),'request receipts redact image and mask payloads');

const input={kind:'image',referenceAssetIds:['source','guide'],imageEdit:{mode:'local_composite',sourceAssetId:'source',maskAssetId:'mask',strength:0.65}};
validateStudioImageEdit(input);
assert.deepEqual(studioInputAssetIds(input).sort(),['guide','mask','source']);
for(const broken of [
  {...input,kind:'video'}, {...input,imageEdit:{...input.imageEdit,strength:2}}, {...input,imageEdit:{...input.imageEdit,mode:'pretend'}},
  {...input,referenceAssetIds:['guide','source']}, {...input,referenceAssetIds:['source','mask']}, {...input,referenceAssetIds:['source','source']},
  {...input,referenceAssetIds:undefined}, {...input,imageEdit:{...input.imageEdit,mode:'native_mask'}}, {...input,imageEdit:{...input.imageEdit,instruction:14}},
]) assert.throws(()=>validateStudioImageEdit(broken),/image mask edit/);
const canvas={...createStudioCanvas('Mask package'),nodes:[{id:'edit',kind:'image',name:'Local edit',prompt:'Replace',x:0,y:0,generation:input}]};
const assets=['source','guide','mask','raw'].map(id=>({id,name:id,kind:'image',url:png,category:'reference',createdAt:new Date().toISOString()}));
const imported=parseStudioBundle({canvas,assets},'canvas'), importedInput=imported.canvas.nodes[0].generation;
const mapped=id=>imported.assets.find(asset=>asset.name===id).id;
assert.equal(importedInput.imageEdit.sourceAssetId,mapped('source')); assert.equal(importedInput.imageEdit.maskAssetId,mapped('mask'));
assert.deepEqual(importedInput.referenceAssetIds,[mapped('source'),mapped('guide')]);
assert.throws(()=>parseStudioBundle({canvas,assets:assets.filter(asset=>asset.id!=='mask')},'canvas'),/missing/);
assert.throws(()=>parseStudioCanvas({...canvas,nodes:[{...canvas.nodes[0],generation:{...input,imageEdit:{...input.imageEdit,strength:NaN}}}]}),/image mask edit/);
const state={canvases:[],worlds:[],commerceProjects:[],jobs:[{status:'running',input,rawOutputAssetId:'raw'}],assets,trashedAssets:[]};
assert.deepEqual([...referencedStudioAssets(state)].sort(),['guide','mask','raw','source']);
assert.equal(trashLibraryAssets(state,assets.map(asset=>asset.id),new Date().toISOString()).blocked.length,4,'in-flight local retries protect source, mask, guide and successful candidate');
console.log('Image mask contracts passed: exact outside pixels, alpha blending, native WebUI payload, redaction, adapter truth, package remapping and recycle protection.');
