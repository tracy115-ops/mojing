import { providerRouter } from '@/services/providers';
import { parseStudioCanvas, parseWorldDocument } from './document';
import type { StudioAsset, StudioCanvas, WorldDocument } from '@/types/video-studio';
import { WORLD_PROP_IDS } from './world-sets';

export function parseDirectorJSON(text: string): unknown {
  const raw = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(raw);
}
export async function directWorld(world: WorldDocument, brief: string, assets: StudioAsset[], endpointId: string, model?: string): Promise<WorldDocument> {
  const response = await providerRouter.generate({
    taskType: 'planning', endpointId, model, responseFormat: 'json', temperature: 0.35, maxTokens: 10000,
    systemPrompt: `You are a film previs director. Return only one complete WorldDocument JSON object matching the supplied current document. The user's language must be used for names. Units: meters, radians, seconds. Ground is XZ, Y is up. Actors face +Z, are 1.8m tall. Use a single readable action, motivated camera blocking, and uncluttered composition. Duration 1..60; fps 15,24,25,30; ratio 16:9,9:16,1:1,4:3,3:4,21:9. Environment day,sunset,night,fog. Light intensity 0..6; focalLength 12..200. Object kinds actor,box,sphere,cylinder,tree,building,model. All objects have unique id,name,kind,color (#rrggbb),visible,transform(position,rotation,scale as length-3 number arrays),keyframes([{time,transform}]). Each scale must be positive. Keyframes must stay within duration and have unique times. Actor motion idle,walk,run,wave. Camera has position,target,focalLength,keyframes([{time,position,target}]). markerA,markerB are length-3 arrays; groundColor #rrggbb. Preserve existing cameraBookmarks and cameraSequence unless the brief requests changes. cameraBookmarks contain {id,name,camera} using scene-time camera keyframes. Optional cameraSequence is {enabled:boolean,shots:[{id,name,duration,camera}]}; at most 24 uniquely identified shots, each duration >= 0.25 seconds, total <= 60 seconds; enabled requires a nonempty shot list. Sequence camera keyframes use local shot time within that shot duration. Cuts share continuous scene time for actors and objects; the scene duration and sequence total can differ. Camera snapshots are independent of bookmarks. Preserve existing model asset IDs, animationClip indices and animationPlayback unless explicitly asked to change timing. Never invent clip indices. Optional model animationPlayback is {startTime:0..60,inPoint:0..3600,outPoint?:0..3600,speed:0.1..4,loop:"repeat"|"once"}; outPoint must exceed inPoint, and animationClip must be set. Source times are seconds within the embedded clip; startTime is absolute continuous world time, including across camera cuts. Before start hold the source in pose; once holds the out pose. Do not invent asset IDs or remote URLs. No code, no markdown, no commentary.`,
    userPrompt: JSON.stringify({ brief, current: world, availableModels: assets.filter((asset) => asset.kind === 'model').map(({ id, name }) => ({ id, name })), builtInProps: { ids: WORLD_PROP_IDS, usage: 'Use kind=model and builtinModel=id, with no assetId. Preserve existing builtinModel fields.' } }),
  });
  const result = parseWorldDocument(parseDirectorJSON(response.content));
  for (const object of result.objects) if (object.assetId && !assets.some((asset) => asset.id === object.assetId && asset.kind === 'model')) throw new Error('The proposal refers to an unavailable 3D asset');
  return { ...result, id: world.id };
}
export async function directCanvas(canvas: StudioCanvas, brief: string, assets: StudioAsset[], worlds: WorldDocument[], endpointId: string, model?: string): Promise<StudioCanvas> {
  const response = await providerRouter.generate({
    taskType: 'planning', endpointId, model, responseFormat: 'json', temperature: 0.4, maxTokens: 8000,
    systemPrompt: `You are a visual production planner. Return a complete StudioCanvas JSON object with name,nodes,edges,viewport. Use the user's language. Each node: unique id,kind (text,image,video,audio,model,world),name,prompt,x,y, optional assetId/worldId. Each edge: id,from,to. Arrange nodes left to right 320px apart, rows 360px apart. Connections supply upstream text and image assets to downstream generation; avoid cycles. Keep existing nodes and references unless the user requests removal. Build concrete, concise prompts, one main action per video, consistent cast/wardrobe/settings. Do not invent asset IDs/world IDs or URLs. Max 50 nodes. Do not generate any media, call tools, or output code. Only JSON.`,
    userPrompt: JSON.stringify({ brief, current: canvas, availableAssets: assets.map(({ id, kind, name }) => ({ id, kind, name })), availableWorlds: worlds.map(({ id, name }) => ({ id, name })) }),
  });
  const result = parseStudioCanvas(parseDirectorJSON(response.content));
  if (result.nodes.length > 50) throw new Error('The proposal exceeds 50 nodes');
  for (const node of result.nodes) {
    if (node.assetId && !assets.some((asset) => asset.id === node.assetId && (asset.kind === node.kind || node.kind === 'world' && asset.kind === 'image'))) throw new Error('The proposal refers to an unavailable asset');
    if (node.worldId && !worlds.some((world) => world.id === node.worldId)) throw new Error('The proposal refers to an unavailable world');
  }
  return { ...result, id: canvas.id };
}
