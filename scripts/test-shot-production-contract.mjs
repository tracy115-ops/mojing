import assert from 'node:assert/strict';
import {
  getShotProductionReadiness,
  getAssemblyBlockers,
  isShotAssemblyReady,
  isShotKeyframeApproved,
  registerPersistedShotVersions,
  restoreClipFromShotVersion,
} from '../src/services/video/core/shot-production-contract.ts';
import { fingerprintShotInputs, fingerprintImportedVideo, isGeneratedVideoCurrent } from '../src/services/video/core/shot-generation-receipt.ts';
import { getCandidateSeed } from '../src/services/video/core/shot-continuity.ts';

const shot = {
  id: 'shot-1',
  index: 0,
  sourceText: 'A subject crosses the room.',
  videoPrompt: 'The subject crosses the room.',
  characterIds: ['subject'],
  durationSeconds: 5,
  keyframeImage: 'C:/assets/keyframe.png',
};

const clip = {
  shotId: shot.id,
  videoUrl: 'C:/assets/clip.mp4',
  durationSeconds: 5,
  provider: 'custom',
  model: 'video-model',
  hasAudio: false,
  generatedAt: '2026-09-13T00:00:00.000Z',
};

assert.equal(getShotProductionReadiness(shot, clip, false).state, 'needs_video', 'legacy clips without a receipt must be regenerated');
assert.equal(
  getShotProductionReadiness({ ...shot, unresolvedCharacterRefs: ['planner-label'] }, clip, false).state,
  'needs_binding',
  'unresolved planner references must block generation until a human binds the subject',
);

const currentClip = {
  ...clip,
  videoReferenceAssets: [],
  generationContext: {
    provider: 'custom',
    model: 'video-model',
    endpointId: 'video-endpoint',
    aspectRatio: '16:9',
    resolution: '1920x1080',
    fps: 24,
  },
  requestSnapshot: {
    schemaVersion: 1,
    taskType: 'clip',
    model: 'video-model',
    controlMode: 'keyframe',
    promptFingerprint: 'prompt-a',
    parameterValues: { durationSeconds: 5 },
    acceptedParameterKeys: ['durationSeconds'],
    rejectedParameterKeys: [],
    referenceSlots: [],
  },
  responseSnapshot: {
    schemaVersion: 1,
    outputKind: 'video',
    outputFingerprint: 'output-a',
    width: 1920,
    height: 1080,
    durationSeconds: 5,
    provider: 'custom',
    model: 'video-model',
  },
};
currentClip.inputFingerprint = fingerprintShotInputs(
  shot,
  'video',
  currentClip.videoReferenceAssets,
  currentClip.generationContext,
);

const migrated = registerPersistedShotVersions([shot], [currentClip], '2026-09-13T00:00:00.000Z')[0];
assert.equal(migrated.versionHistory?.length, 2, 'legacy still and clip should become candidates');
assert.equal(migrated.versionHistory?.every((version) => version.reviewStatus === 'unreviewed'), true);
assert.equal(migrated.versionHistory?.find((version) => version.type === 'video')?.id, migrated.selectedVersionId);
assert.equal(migrated.lockedVersionId, undefined, 'legacy outputs must never be locked automatically');
assert.equal(migrated.versionHistory?.find((version) => version.type === 'video')?.requestSnapshot?.promptFingerprint, 'prompt-a', 'video version keeps the exact request snapshot');
assert.equal(migrated.versionHistory?.find((version) => version.type === 'video')?.responseSnapshot?.outputFingerprint, 'output-a', 'video version keeps the provider output snapshot');
assert.equal(getShotProductionReadiness(migrated, currentClip, false).state, 'awaiting_review');
assert.equal(isShotAssemblyReady(migrated, currentClip), false);

const videoVersion = migrated.versionHistory.find((version) => version.type === 'video');
assert.ok(videoVersion);
const approved = {
  ...migrated,
  selectedVersionId: videoVersion.id,
  lockedVersionId: videoVersion.id,
  versionHistory: migrated.versionHistory.map((version) => (
    version.id === videoVersion.id ? { ...version, reviewStatus: 'approved' } : version
  )),
};
assert.equal(isShotAssemblyReady(approved, currentClip), true, 'only an approved locked video can assemble');
assert.equal(getAssemblyBlockers([migrated], [currentClip]).length, 1);
assert.equal(getAssemblyBlockers([approved], [currentClip]).length, 0);

const keyframeContext = {
  provider: 'custom',
  model: 'image-model',
  endpointId: 'image-endpoint',
  aspectRatio: '16:9',
};
const approvedKeyframe = {
  id: 'keyframe-current',
  type: 'image',
  url: shot.keyframeImage,
  createdAt: '2026-09-13T00:00:00.000Z',
  inputFingerprint: fingerprintShotInputs(shot, 'keyframe', [], keyframeContext),
  imageReferenceAssets: [],
  imageGenerationContext: keyframeContext,
  reviewStatus: 'approved',
};
const approvedKeyframeShot = {
  ...shot,
  keyframeInputFingerprint: approvedKeyframe.inputFingerprint,
  keyframeGenerationContext: keyframeContext,
  referenceAssets: [],
  versionHistory: [approvedKeyframe],
};
assert.equal(isShotKeyframeApproved(approvedKeyframeShot), true, 'an approved current keyframe may drive I2V');
assert.equal(
  isShotKeyframeApproved({ ...approvedKeyframeShot, sourceText: 'The subject crosses a different room.' }),
  false,
  'editing shot inputs invalidates the previous keyframe approval',
);
assert.equal(
  getShotProductionReadiness({ ...approvedKeyframeShot, sourceText: 'The subject crosses a different room.' }, undefined, true).state,
  'needs_keyframe_review',
  'the UI must expose a stale keyframe instead of treating it as approved',
);

const technicallyFailed = {
  ...approved,
};
assert.equal(
  isShotAssemblyReady(technicallyFailed, {
    ...currentClip,
    shotVersionId: videoVersion.id,
    qualityReview: { status: 'failed', score: 20, reviewedAt: currentClip.generatedAt, checks: [] },
  }),
  false,
  'a technically failed clip cannot enter assembly even after human approval',
);

assert.equal(
  isShotAssemblyReady(approved, {
    ...currentClip,
    shotVersionId: videoVersion.id,
    visualReview: {
      status: 'failed',
      score: 35,
      reviewedAt: currentClip.generatedAt,
      frameCount: 3,
      checks: [],
    },
  }),
  false,
  'a visually failed clip cannot enter assembly even after human approval',
);

assert.equal(
  isShotAssemblyReady(approved, {
    ...currentClip,
    shotVersionId: videoVersion.id,
    visualReview: {
      status: 'unavailable',
      reviewedAt: currentClip.generatedAt,
      frameCount: 0,
      checks: [],
    },
  }),
  true,
  'an unavailable visual review remains a human-review decision, not a false visual pass',
);

const imageOnly = {
  ...migrated,
  selectedVersionId: migrated.versionHistory.find((version) => version.type === 'image')?.id,
  lockedVersionId: migrated.versionHistory.find((version) => version.type === 'image')?.id,
};
assert.equal(isShotAssemblyReady(imageOnly, currentClip), false, 'an image version is never an assembly lock');

const candidateA = {
  id: 'video-a',
  type: 'video',
  url: 'C:/assets/clip-a.mp4',
  createdAt: '2026-09-13T00:01:00.000Z',
  provider: 'custom',
  model: 'video-model',
  durationSeconds: 5,
  inputFingerprint: 'receipt-a',
  generationContext: { provider: 'custom', model: 'video-model', endpointId: 'endpoint-a' },
  videoReferenceAssets: [{ id: 'ref-a', kind: 'keyframe', label: 'first frame', imageUrl: 'C:/assets/a.png', sentToProvider: true }],
  requestSnapshot: { ...currentClip.requestSnapshot, promptFingerprint: 'prompt-b' },
  responseSnapshot: { ...currentClip.responseSnapshot, outputFingerprint: 'output-b' },
  videoControlMode: 'keyframe',
  videoReferenceMode: 'i2v',
  qualityReview: { status: 'passed', score: 96, reviewedAt: '2026-09-13T00:01:01.000Z', checks: [] },
  reviewStatus: 'approved',
};
const candidateB = {
  ...candidateA,
  id: 'video-b',
  url: 'C:/assets/clip-b.mp4',
  inputFingerprint: 'receipt-b',
  generationContext: { provider: 'custom', model: 'video-model', endpointId: 'endpoint-b' },
  videoReferenceAssets: [{ id: 'ref-b', kind: 'character', label: 'subject', imageUrl: 'C:/assets/b.png', sentToProvider: true }],
  qualityReview: { status: 'warning', score: 72, reviewedAt: '2026-09-13T00:02:01.000Z', checks: [] },
};
const restoredB = restoreClipFromShotVersion({ ...currentClip, videoUrl: candidateA.url, inputFingerprint: candidateA.inputFingerprint }, candidateB);
assert.equal(restoredB.videoUrl, candidateB.url);
assert.equal(restoredB.inputFingerprint, candidateB.inputFingerprint);
assert.equal(restoredB.videoReferenceAssets?.[0]?.id, 'ref-b', 'switching candidates must switch the reference ledger');
assert.equal(restoredB.qualityReview?.score, 72, 'switching candidates must switch the quality report');
assert.equal(restoredB.requestSnapshot?.promptFingerprint, 'prompt-b', 'switching candidates must switch the request snapshot');
assert.equal(restoredB.responseSnapshot?.outputFingerprint, 'output-b', 'switching candidates must switch the output snapshot');
const restoredLegacy = restoreClipFromShotVersion({ ...currentClip, videoUrl: candidateA.url, inputFingerprint: candidateA.inputFingerprint }, {
  id: 'legacy-video',
  type: 'video',
  url: 'C:/assets/old.mp4',
  createdAt: '2026-09-13T00:03:00.000Z',
});
assert.equal(restoredLegacy.inputFingerprint, undefined, 'legacy candidates must not borrow the current receipt');
assert.notEqual(getCandidateSeed({ id: 'shot-1' }, undefined, 1), getCandidateSeed({ id: 'shot-1' }, undefined, 2));
assert.equal(getCandidateSeed({ id: 'shot-1' }, 1234, 1), getCandidateSeed({ id: 'shot-1' }, 1234, 1), 'candidate seeds must be reproducible');

console.log('shot production contract tests passed (21 assertions)');

const importedShot = { ...shot, keyframeImage:undefined };
const importedReceipt = { kind:'imported_video', sourceAssetId:'studio-one', sourceUrl:'C:/assets/import.mp4', sha256:'a'.repeat(64), width:1920,height:1080,durationSeconds:5, inspectedAt:'2026-11-16T00:00:00Z', shotInputFingerprint:fingerprintShotInputs(importedShot,'video'), audio:'preserve' };
const importedVersion = { id:'import-one',type:'video',url:importedReceipt.sourceUrl,createdAt:importedReceipt.inspectedAt,provider:'custom',model:'imported-video',durationSeconds:5, importedVideo:importedReceipt,inputFingerprint:fingerprintImportedVideo(importedReceipt),qualityReview:{status:'passed',checks:[],score:100,reviewedAt:importedReceipt.inspectedAt},reviewStatus:'unreviewed' };
const importedClip = restoreClipFromShotVersion(clip,importedVersion);
const importedWithVersion = {...importedShot,selectedVersionId:importedVersion.id,versionHistory:[importedVersion]};
assert.equal(importedClip.hasAudio,true,'preserve original soundtrack and suppress automatic dubbing');
assert.equal(importedClip.generationContext,undefined,'imports cannot borrow the old provider context');
assert.equal(isGeneratedVideoCurrent(importedWithVersion,importedClip),true);
assert.equal(getShotProductionReadiness(importedWithVersion,importedClip).state,'awaiting_review','an inspected import does not need a generated keyframe');
assert.equal(isShotAssemblyReady(importedWithVersion,importedClip),false,'inspection never grants approval');
const approvedImport={...importedWithVersion,lockedVersionId:importedVersion.id,versionHistory:[{...importedVersion,reviewStatus:'approved'}]};
assert.equal(isShotAssemblyReady(approvedImport,importedClip),true);
assert.equal(isShotAssemblyReady(approvedImport,importedClip,{visualReviewRequired:true}),false,'visual policy applies to imports');
assert.equal(isShotAssemblyReady(approvedImport,{...importedClip,qualityReview:undefined}),false);
assert.equal(isShotAssemblyReady({...approvedImport,videoPrompt:'A different action'},importedClip),false,'changed shot requirements invalidate imported approval');
assert.equal(isGeneratedVideoCurrent(importedShot,{...importedClip,videoUrl:'C:/other.mp4'}),false);
assert.equal(isGeneratedVideoCurrent(importedShot,{...importedClip,importedVideo:{...importedReceipt,sha256:'b'.repeat(64)}}),false);
assert.equal(isGeneratedVideoCurrent(importedShot,{...importedClip,durationSeconds:10}),false);
assert.equal(restoreClipFromShotVersion(importedClip,videoVersion).importedVideo,undefined,'selecting a generated candidate clears import provenance');
assert.equal(registerPersistedShotVersions([importedShot],[importedClip])[0].versionHistory.find(v=>v.type==='video').importedVideo.sha256,importedReceipt.sha256);
console.log('Imported video provenance, review and assembly gates passed.');

const sameBytesImported = restoreClipFromShotVersion({...currentClip,videoUrl:importedVersion.url,keyframeImage:'old-keyframe'},importedVersion);
assert.equal(sameBytesImported.generationContext,undefined,'importing an identical file still cannot borrow a model receipt');
assert.equal(sameBytesImported.requestSnapshot,undefined);
assert.equal(sameBytesImported.responseSnapshot,undefined);
assert.equal(sameBytesImported.keyframeImage,undefined);
