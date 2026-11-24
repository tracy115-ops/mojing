import assert from 'node:assert/strict';
import {applyStoryPlanAssessment,validateWizardPlot} from '../src/services/novel/story-plan-contract.ts';
const plan={mainPlot:'发现异常车票后上报并核对来源。',ending:'查清日期印制来源。',stages:[{description:'上报并当面核对',coreEvent:'购买两张车票作比对'}]};
const result={ready:true,edits:[{path:['stages',0,'coreEvent'],replacement:'拍照后核对原始票据',reason:'保留原始票据数量。'}],unresolvedIssues:[]};
const apply=(override={},draft=plan)=>applyStoryPlanAssessment(JSON.stringify({...result,...override}),JSON.stringify(draft));
assert.deepEqual(apply().plan,{...plan,stages:[{...plan.stages[0],coreEvent:'拍照后核对原始票据'}]});
assert.deepEqual(apply().changes,['保留原始票据数量。']);
assert.deepEqual(apply({edits:[]}),{plan,changes:[]});
validateWizardPlot(plan);
for(const p of [{...plan,mainPlot:''},{...plan,ending:''},{...plan,stages:[]},{...plan,stages:[{description:'仅有描述'}]}]) assert.throws(()=>validateWizardPlot(p),/缺少/);
assert.throws(()=>apply({ready:false,unresolvedIssues:['购票时间早于亡妻去世，却声称是忌日购票']}),/购票时间/);
assert.throws(()=>apply({unresolvedIssues:['包内新增物品']}),/包内新增物品/,'a ready flag cannot hide unresolved contradictions');
for(const override of [{ready:'true'},{edits:undefined,plan,changes:['声称已经修改']},{unresolvedIssues:[null]}]) assert.throws(()=>apply(override),/不完整/);
assert.throws(()=>apply({},[]),/不完整/);
const [edit]=result.edits;
for(const invalid of [{...edit,path:['stages',2,'coreEvent']},{...edit,path:['__proto__','toString']},{...edit,replacement:plan.stages[0].coreEvent}]) {
  assert.throws(()=>apply({edits:[invalid]}),/未能应用/);
}
assert.throws(()=>apply({edits:[edit,{...edit,path:['stages','0','coreEvent']}]}),/未能应用/);
console.log('Story plan contracts: edits reach the selected fields, unresolved contradictions and unapplied edits block adoption.');
