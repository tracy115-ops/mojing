import assert from 'node:assert/strict';
import { buildWritingContext, getNovelChapters, textFingerprint } from '../src/services/novel/writing-context.ts';
import { EDITORIAL_DIMENSIONS, parseEditorialAssessment, needsEditorialRevision, applyEditorialEdits, parseEditorialEdits, labelEditorialParagraphs, parseOutlineAssessment, resolveEditorialCitation, resolveEditorialParagraph, isReviewCurrent } from '../src/services/novel/editorial-review.ts';
import { getDueForeshadowing, lastWrittenChapter } from '../src/services/novel/workbench-state.ts';

const source = { title: '末班车之后', description: '包里只有一张日期为明天的车票，禁止超自然。', genre: 'mystery', style: '克制现实叙事' };
const bible = { novelId: 'test', characters: [], locations: [], worldSettings: [], styleNotes: [], timelineNotes: [{ id: 'plot-outline', event: '规划：交还失物' }] };
const chapter = (order, content, outline = '') => ({ id: 'c' + order, order, title: '章' + order, content, outline, wordCount: content.length, status: 'drafting' });
const chapters = [chapter(2, '未来章节的秘密不能提前泄漏。'), chapter(0, '林岚把车票交给保安登记。' + '雨夜收车。'.repeat(150)), chapter(1, '林岚仍在值班室等监控，车票由保安保管。', '计划拿回车票但尚未发生')];
const context = buildWritingContext(source, bible, chapters, 2);
assert.ok(context.includes('林岚把车票交给保安登记。'), 'retain decisive facts before the last 500 characters');
assert.ok(context.indexOf('第1章《章0》') < context.indexOf('第2章《章1》'), 'chronological context regardless of storage order');
assert.ok(!context.includes('未来章节的秘密'), 'future prose must not leak into earlier chapters');
assert.ok(!context.includes('计划拿回车票但尚未发生'), 'outlines are not summaries of events that occurred');
assert.ok(context.includes('待实现的剧情规划，不是已发生事实'));
const plotOutline = { mainPlot:'核对备用票的提前领用', coreConflict:'保护师傅还是保留真实记录', themeMessage:'善意不能替代事实', ending:'查明预盖日期，保留原始报告', stages:[{name:'留下报告',chapterRange:'第1-3章',description:'上报后被要求撤回',coreEvent:'林岚拒绝改日期',foreshadowSeeds:['交接簿上的预领栏']}] };
for (const purpose of ['writing', 'review']) {
  const plotContext = buildWritingContext(source,bible,chapters,2,[],purpose,{plotOutline});
  for (const token of ['作者全书情节方案，尚待实现','查明预盖日期，保留原始报告','林岚拒绝改日期','交接簿上的预领栏','不能当作已经发生的事实','角色获知真相仍须有正文中的来源']) assert.ok(plotContext.includes(token), `${purpose}: ${token}`);
  const editedContext = buildWritingContext(source,bible,chapters,2,[],purpose,{plotOutline:{...plotOutline,ending:'作者修改结局'}});
  assert.notEqual(textFingerprint(plotContext),textFingerprint(editedContext),'changing the ending invalidates cached editorial context');
}
assert.equal(context.includes('作者全书情节方案，尚待实现'),false,'legacy projects without a full plot remain readable');
const withStyle = {...bible,styleNotes:[{key:'文风公约',value:'心理描写全部外化'}],worldSettings:[{name:'车票',description:'备用票日期栏手写。'},{name:'调查',description:'照片不能替代实物检查。'}]};
const reviewContext = buildWritingContext(source,withStyle,chapters,2,[],'review');
assert.ok(reviewContext.includes('不能仅因心理直述'));
assert.ok(reviewContext.includes('文风偏好，服务于内容，不是事实或逐句禁令'));
assert.ok(reviewContext.includes('心理描写全部外化'),'retain author preferences with explicit reading priority, rather than silently rewriting saved settings');
assert.match(reviewContext,/备用票日期栏手写。\n\n【世界设定：调查】/,'distinct rules are separate evidence paragraphs');

const older = [...chapters.filter(c => c.order < 2), chapter(2, '第三章事实。'), chapter(3, '第四章事实。')];
const memory = { chapter: 0, contentFingerprint: textFingerprint(older[0].content), continuityNotes: [{ fact: '缓存的保管状态', quote: '林岚把车票交给保安登记。' }] };
const archivedContext = buildWritingContext(source,bible,older,4,[memory]);
assert.match(archivedContext, /第1章原文片段，由审读选取】\n林岚把车票交给保安登记。/);
assert.ok(!archivedContext.includes('缓存的保管状态'), 'editorial paraphrases cannot become facts in later chapters');
const changed = older.map(c => c.order === 0 ? { ...c, content: c.content + '作者修改。' } : c);
assert.ok(!buildWritingContext(source,bible,changed,4,[memory]).includes('第1章原文片段，由审读选取'), 'editing a chapter invalidates its cached excerpts');

const metadata = { chapters: [chapter(9,'旧版正文')], storyNodes: [{ id:'b',nodeType:'chapter',order:20,content:'后章' }, { id:'v',nodeType:'volume',order:0 }, {id:'a',nodeType:'chapter',order:10,content:'前章'}] };
assert.deepEqual(getNovelChapters(metadata).map(c => [c.id,c.order,c.content]), [['a',0,'前章'],['b',1,'后章']], 'reading tools share the current story tree rather than stale legacy chapters');

const referenceBible = { ...bible, characters: [{ id:'driver',name:'林岚',description:'司机',appearance:'',personality:'',relationships:[],backstory:'熟悉交接程序' }] };
const refs = {
  worldbuilding: { dimensions: { society: { title:'单位规则',fields:{handover:'上报缺票必须留存编号'} } } },
  storylines:[{name:'库存核对',status:'active',description:'通过交接记录核对数量',chapterRange:[0,8],milestones:[{chapter:9,label:'不可提前发生的结局',completed:true}]}],
  casts:[{chapterIndex:2,lockedCharacters:['driver']}],
  foreshadowing:[{description:'未核实的票号',status:'resolved',plantedInChapter:1,resolvedInChapter:9,suggestedResolveChapter:9}],
  triples:[{subject:'林岚',predicate:'同事',object:'方票务',sinceChapter:0,source:'bible'},{subject:'林岚',predicate:'知道幕后真相',object:'不可信的自动提取',sinceChapter:0,source:'extracted'}],
  props:[{id:'ticket',name:'票夹',description:'40张连号票',attributes:{range:'073801—073840'},holderCharacterId:'未来持有人',lifecycleState:'active',introducedChapter:1}],
  propEvents:[{propId:'ticket',chapterNumber:1,description:'保安登记票夹',toHolderId:'保安'},{propId:'ticket',chapterNumber:9,description:'未来转交',toHolderId:'未来持有人'}],
};
const referenceContext = buildWritingContext(source,referenceBible,chapters,2,[],'writing',refs);
for(const token of ['上报缺票必须留存编号','库存核对','作者本章出场计划','林岚','未核实的票号','方票务','073801—073840','保安登记票夹']) assert.ok(referenceContext.includes(token),token);
for(const token of ['不可信的自动提取','不可提前发生的结局','台账记为第9章已回收','未来转交','持有者：未来持有人']) assert.equal(referenceContext.includes(token),false,token);
assert.ok(referenceContext.includes('不强制本章闭合'));
const datedProp = { ...refs.props[0], stateAsOfChapter: 3 };
for (const prop of [refs.props[0], datedProp]) {
  const earlier = buildWritingContext(source, referenceBible, chapters, 2, [], 'writing', { props: [prop] });
  assert.equal(earlier.includes('未来持有人'), false, 'undated and later prop custody cannot influence an earlier chapter');
  assert.ok(earlier.includes('40张连号票'), 'timeless prop description remains available');
}
const confirmedProp = buildWritingContext(source, referenceBible, chapters, 3, [], 'writing', { props: [datedProp] });
assert.match(confirmedProp, /截至第3章台账状态：active；持有者：未来持有人/);
const fourOfThirtyFour = Array.from({length:34},(_,i)=>chapter(i,i<4?'已写正文':''));
assert.equal(lastWrittenChapter(fourOfThirtyFour),4,'empty planned chapters do not advance the written position');
const threads=[{id:'future',status:'planted',plantedInChapter:2,suggestedResolveChapter:10},{id:'due',status:'planted',plantedInChapter:1,suggestedResolveChapter:4},{id:'resolved',status:'resolved',plantedInChapter:1,suggestedResolveChapter:2},{id:'notYetPlanted',status:'planted',plantedInChapter:6,suggestedResolveChapter:4}];
assert.deepEqual(getDueForeshadowing(threads,4).map(f=>f.id),['due'],'only unresolved threads planted and due in written prose are reminders');
assert.equal(lastWrittenChapter([]),0);
assert.deepEqual(getDueForeshadowing(threads,0),[]);

const prose = '林岚把车票放回自己口袋。她没有问保安。';
const assessment = { dimensions: EDITORIAL_DIMENSIONS.map(name => ({name,score:95})), summary:'道具归属冲突会破坏后续调查。', findings:[{dimension:'timeline_consistency',severity:'critical',basis:'conflict',quote:'林岚把车票放回自己口袋。',referenceQuote:'林岚把车票交给保安登记。',currentEvidence:'把车票放回自己口袋',referenceEvidence:'把车票交给保安登记',problem:'未交代取回车票。',suggestion:'补足取回手续，或仍由保安保管。'}],continuityNotes:[{fact:'林岚未询问保安。',quote:'她没有问保安。'}] };
assert.equal(needsEditorialRevision(parseEditorialAssessment(JSON.stringify(assessment),prose,context)),true,'a hard contradiction cannot be averaged away by high scores');
assert.throws(() => parseEditorialAssessment(JSON.stringify({...assessment,findings:[{...assessment.findings[0],quote:'编造的引文'}]}),prose,context), /引用/);
assert.throws(() => parseEditorialAssessment(JSON.stringify({...assessment,findings:[{...assessment.findings[0],referenceQuote:'没有提供的前文'}]}),prose,context), /引用/);
assert.throws(() => parseEditorialAssessment(JSON.stringify({...assessment,dimensions:assessment.dimensions.slice(1)}),prose,context), /不完整/);
assert.throws(() => parseEditorialAssessment(JSON.stringify({...assessment,dimensions:assessment.dimensions.map(d=>({...d,score:101}))}),prose,context), /有效评分/);
assert.equal(needsEditorialRevision({...assessment,findings:[]}),false);
assert.equal(needsEditorialRevision({...assessment,findings:[],dimensions:assessment.dimensions.map(d=>({...d,score:20}))}),false,'an unexplained number cannot invent a revision requirement');
const nightProse = '23点45分，林岚拎包到总站。\n\n老吴说那人二十分钟前来过。';
const timeFinding = { dimension:'timeline_consistency', severity:'major', basis:'conflict', paragraphId:'C2', referenceId:'C1',
  currentEvidence:'二十分钟前', referenceEvidence:'23点45分', problem:'她在23:55下楼，所以来访者实际在23:35到站。', suggestion:'核对来访和转述的先后。' };
const timeReview = parseEditorialAssessment(JSON.stringify({...assessment,findings:[timeFinding],continuityNotes:[]}),nightProse,'');
assert.equal(timeReview.findings[0].basis,'uncertain','a cited relative time cannot verify an invented reporting time');
assert.equal(needsEditorialRevision(timeReview),false,'an uncertain finding never triggers automated revision');
const directProse = '23点45分，林岚拎包到总站。\n\n同一晚的登记写着她在22:40拎包到总站。';
const directReview = parseEditorialAssessment(JSON.stringify({...assessment,findings:[{
  ...timeFinding,currentEvidence:'22:40',problem:'同一次到站分别写为23:45和22:40。',
}],continuityNotes:[]}),directProse,'');
assert.equal(directReview.findings[0].basis,'conflict','numeric and localized spellings of the cited clock time match');
assert.equal(needsEditorialRevision(directReview),true);
const minorConflict = parseEditorialAssessment(JSON.stringify({ ...assessment, findings: [{
  ...timeFinding, severity: 'minor', currentEvidence: '22:40', problem: '同一次到站分别写为23:45和22:40。',
}], continuityNotes: [] }), directProse, '');
assert.equal(minorConflict.findings[0].severity, 'critical');
assert.equal(needsEditorialRevision(minorConflict), true, 'a valid evidence pair blocks the gate even if the model rated it minor');
const proposalOnly = parseEditorialAssessment(JSON.stringify(assessment),prose,context,()=>false);
assert.equal(proposalOnly.findings[0].basis,'uncertain','a proposed story plan is not evidence of a past event');
const numbered = {...assessment, findings:[{...assessment.findings[0],quote:undefined,referenceQuote:undefined,paragraphId:'C1',referenceId:'R1'}],continuityNotes:[{fact:'原文事实',paragraphId:'C1'}]};
assert.ok(labelEditorialParagraphs(prose).startsWith('[C1]'));
assert.equal(parseEditorialAssessment(JSON.stringify(numbered),prose,context).findings[0].quote,prose,'paragraph references quote the actual source rather than regenerated quotations');
assert.throws(()=>parseEditorialAssessment(JSON.stringify({...numbered,findings:[{...numbered.findings[0],paragraphId:'C999'}]}),prose,context), /未提供/);
const multiParagraph = Array.from({length:100},(_,i)=>`第${i+1}段原文。`).join('\r\n \r\n');
const rangeReview = {...numbered,findings:[{...numbered.findings[0],paragraphId:'C40-C48',referenceId:'C77'}],continuityNotes:[{fact:'一个段落范围支持的事实',paragraphId:'C95-C96'}]};
const parsedRange = parseEditorialAssessment(JSON.stringify(rangeReview),multiParagraph,context);
assert.equal(parsedRange.findings[0].quote,Array.from({length:9},(_,i)=>`第${i+40}段原文。`).join('\r\n \r\n'),'preserve source separators across real-world C40-C48 evidence');
assert.equal(parsedRange.findings[0].referenceQuote,'第77段原文。','allow comparisons within the current chapter');
assert.equal(resolveEditorialCitation('重复。\n\n重复。\n \n结尾。','C2-C3'),'重复。\n \n结尾。','repeated paragraphs resolve by position');
assert.throws(()=>resolveEditorialParagraph(multiParagraph,'C40-C48'),/编号无效/,'revision anchors remain one exact paragraph');
for (const id of ['C48-C40','C40-C101','C1-C21','C1-R3','C0','C01','C40-48','C2,C3']) {
  assert.throws(()=>resolveEditorialCitation(multiParagraph,id),/无效|未提供/,id);
}
assert.throws(()=>parseEditorialAssessment(JSON.stringify({...rangeReview,findings:[{...rangeReview.findings[0],referenceId:'R77'}]}),multiParagraph,'仅有一段前文'),/未提供/,'do not silently switch an invalid source to the current chapter');
const fingerprints = {contentFingerprint:textFingerprint(prose),contextFingerprint:textFingerprint(context)};
assert.ok(isReviewCurrent(fingerprints,prose,context));
assert.equal(isReviewCurrent(fingerprints,prose,context+'新设定。'),false,'setting changes invalidate a report even when the chapter is unchanged');
assert.equal(isReviewCurrent(fingerprints,prose+'改文。',context),false);
assert.equal(isReviewCurrent(null,prose,context),false);
assert.throws(()=>parseOutlineAssessment(JSON.stringify({ready:true,outline:'',changes:[],unresolvedIssues:[]})), /不完整/);
assert.throws(()=>parseOutlineAssessment(JSON.stringify({ready:true,outline:'未修正的方案',changes:[],unresolvedIssues:['道具归属仍有矛盾']})), /未解决/);
assert.equal(parseOutlineAssessment(JSON.stringify({ready:false,outline:'',changes:[],unresolvedIssues:['无法合理接续']})).ready,false);

const longProse = '开头需要修改。' + '保留完整中段。'.repeat(1000) + '结尾：保安握着登记簿，等她签字。';
const edits = [{ before:'开头需要修改。', after:'林岚收起湿伞。',reason:'动作进入场景。' }];
assert.equal(applyEditorialEdits(longProse,edits), '林岚收起湿伞。' + longProse.slice('开头需要修改。'.length));
assert.throws(() => applyEditorialEdits(longProse,[{before:'保留完整中段。',after:'替换',reason:'错误的重复锚点'}]), /出现多次/);
assert.throws(() => applyEditorialEdits(longProse,[...edits,{before:'需要修改。',after:'改文',reason:'重叠'}]), /重叠/);
assert.throws(() => applyEditorialEdits(longProse,[{before:'模型臆造原文',after:'改文',reason:'无效'}]), /不存在/);
assert.throws(() => applyEditorialEdits('全文',[{before:'全文',after:'',reason:'误删'}]), /清空/);
const structuralDraft = '林岚进了值班室。\r\n \r\n她把票夹交给保安。\r\n \r\n她取出票夹里的车票。\r\n \r\n保安等她签字。';
const structuralEdits = parseEditorialEdits(JSON.stringify({ edits: [{ paragraphId: 'C2-C3', after: '她请保安翻开票夹，指着相邻的两个票号，请他在登记簿上记下。', reason: '票夹由保安持有，核对由双方当面完成。' }] }), structuralDraft);
assert.equal(structuralEdits[0].before, '她把票夹交给保安。\r\n \r\n她取出票夹里的车票。');
assert.equal(applyEditorialEdits(structuralDraft, structuralEdits), '林岚进了值班室。\r\n \r\n她请保安翻开票夹，指着相邻的两个票号，请他在登记簿上记下。\r\n \r\n保安等她签字。', 'repair related paragraphs while preserving the opening, ending and original separators');
assert.deepEqual(parseEditorialEdits('{"edits":[]}', structuralDraft), []);
assert.throws(() => parseEditorialEdits(JSON.stringify({ edits: [{ paragraphId:'C2-C3',after:'新段落',reason:'跨段修改' },{paragraphId:'C3',after:'另一修改',reason:'重复修改'}] }),structuralDraft), /重叠/);
assert.throws(() => parseEditorialEdits(JSON.stringify({ edits: [{ paragraphId:'C2-C9',after:'新段落',reason:'越界'}] }),structuralDraft), /未提供/);
assert.throws(() => parseEditorialEdits(JSON.stringify({ edits: [{ paragraphId:'R2-R3',after:'改前文',reason:'越权'}] }),structuralDraft), /无效/);
assert.throws(() => parseEditorialEdits(JSON.stringify({ edits: [{ paragraphId:'C1-C4',after:'',reason:'误删全文'}] }),structuralDraft), /清空/);
assert.throws(() => parseEditorialEdits(JSON.stringify({ edits: [null] }),structuralDraft), /有效对象/);
console.log('Novel editorial contracts passed: chronological source text, no future/outline facts, stale-memory rejection, current story tree, grounded review, hard-conflict gate, exact edits and full ending preservation.');
