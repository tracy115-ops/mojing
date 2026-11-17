import assert from 'node:assert/strict';
import { buildWritingContext, getNovelChapters, textFingerprint } from '../src/services/novel/writing-context.ts';
import { EDITORIAL_DIMENSIONS, parseEditorialAssessment, needsEditorialRevision, applyEditorialEdits, labelEditorialParagraphs, parseOutlineAssessment } from '../src/services/novel/editorial-review.ts';

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

const older = [...chapters.filter(c => c.order < 2), chapter(2, '第三章事实。'), chapter(3, '第四章事实。')];
const memory = { chapter: 0, contentFingerprint: textFingerprint(older[0].content), continuityNotes: [{ fact: '缓存的保管状态', quote: '林岚把车票交给保安登记。' }] };
assert.ok(buildWritingContext(source,bible,older,4,[memory]).includes('缓存的保管状态'));
const changed = older.map(c => c.order === 0 ? { ...c, content: c.content + '作者修改。' } : c);
assert.ok(!buildWritingContext(source,bible,changed,4,[memory]).includes('缓存的保管状态'), 'editing a chapter invalidates its cached facts');

const metadata = { chapters: [chapter(9,'旧版正文')], storyNodes: [{ id:'b',nodeType:'chapter',order:20,content:'后章' }, { id:'v',nodeType:'volume',order:0 }, {id:'a',nodeType:'chapter',order:10,content:'前章'}] };
assert.deepEqual(getNovelChapters(metadata).map(c => [c.id,c.order,c.content]), [['a',0,'前章'],['b',1,'后章']], 'reading tools share the current story tree rather than stale legacy chapters');

const prose = '林岚把车票放回自己口袋。她没有问保安。';
const assessment = { dimensions: EDITORIAL_DIMENSIONS.map(name => ({name,score:95})), summary:'道具归属冲突会破坏后续调查。', findings:[{dimension:'timeline_consistency',severity:'critical',quote:'林岚把车票放回自己口袋。',referenceQuote:'林岚把车票交给保安登记。',problem:'未交代取回车票。',suggestion:'补足取回手续，或仍由保安保管。'}],continuityNotes:[{fact:'林岚未询问保安。',quote:'她没有问保安。'}] };
assert.equal(needsEditorialRevision(parseEditorialAssessment(JSON.stringify(assessment),prose,context)),true,'a hard contradiction cannot be averaged away by high scores');
assert.throws(() => parseEditorialAssessment(JSON.stringify({...assessment,findings:[{...assessment.findings[0],quote:'编造的引文'}]}),prose,context), /引用/);
assert.throws(() => parseEditorialAssessment(JSON.stringify({...assessment,findings:[{...assessment.findings[0],referenceQuote:'没有提供的前文'}]}),prose,context), /引用/);
assert.throws(() => parseEditorialAssessment(JSON.stringify({...assessment,dimensions:assessment.dimensions.slice(1)}),prose,context), /不完整/);
assert.throws(() => parseEditorialAssessment(JSON.stringify({...assessment,dimensions:assessment.dimensions.map(d=>({...d,score:101}))}),prose,context), /有效评分/);
assert.equal(needsEditorialRevision({...assessment,findings:[]}),false);
const numbered = {...assessment, findings:[{...assessment.findings[0],quote:undefined,referenceQuote:undefined,paragraphId:'C1',referenceId:'R1'}],continuityNotes:[{fact:'原文事实',paragraphId:'C1'}]};
assert.ok(labelEditorialParagraphs(prose).startsWith('[C1]'));
assert.equal(parseEditorialAssessment(JSON.stringify(numbered),prose,context).findings[0].quote,prose,'paragraph references quote the actual source rather than regenerated quotations');
assert.throws(()=>parseEditorialAssessment(JSON.stringify({...numbered,findings:[{...numbered.findings[0],paragraphId:'C999'}]}),prose,context), /未提供/);
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
console.log('Novel editorial contracts passed: chronological source text, no future/outline facts, stale-memory rejection, current story tree, grounded review, hard-conflict gate, exact edits and full ending preservation.');
