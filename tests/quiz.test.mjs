import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuizEngine } from '../dist/main/main/quiz.js';
import { defaultSettings } from '../dist/main/shared.js';

const questions = Array.from({ length: 4 }, (_, index) => ({
  id: `q${index}`, kind: 'choice', prompt: `What is ${index} + 1?`, topic: 'Addition', difficulty: 1,
  choices: [String(index + 1), String(index + 2)], correctIndex: 0,
  choiceExplanations: ['Adding one gives the next integer.', 'This adds two instead of one.'], explanation: 'Count one step forward.'
}));

// Hold the coach turn open while the learner progresses and questions arrive late.
test('answers continue during generation and coach additions stay behind the current question', async () => {
  let started;
  const turnStarted = new Promise(resolve => { started = resolve; });
  const calls=[];
  const settings={...defaultSettings,model:'answer-model',reasoningEffort:'low',quizModel:'quiz-model',quizReasoningEffort:'high'};
  const client = { running: true, request: async (method,args) => {
    calls.push({method,args});
    if (method === 'thread/start') return { thread: { id: 'coach' } };
    if (method === 'turn/start') { started(); return { turn: { id: 'review', status: 'inProgress' } }; }
    return {};
  } };
  const states=[];
  const engine = new QuizEngine(client, () => settings, process.cwd(), event => {if(event.method==='quiz/state')states.push(event.params.state);});
  try {
    const bank = engine.createBank({ title: 'Addition', questions });
    const quiz = engine.startQuiz({ bankId: bank.bankId, count: 3 });
    engine.answer({ quizId: quiz.quizId, questionId: 'q0', choiceIndex: 0 });
    await turnStarted;
    const thread=calls.find(call=>call.method==='thread/start').args;
    const turn=calls.find(call=>call.method==='turn/start').args;
    assert.equal(thread.ephemeral,true,'Internal quiz coaching must not create saved desktop chats');
    assert.equal(thread.model,'quiz-model');assert.equal(thread.config.model_reasoning_effort,'high');
    assert.equal(turn.model,'quiz-model');assert.equal(turn.effort,'high');
    assert.ok(states.some(state=>state.quiz?.coachBusy),'Coach must announce that it started before any tool call');
    engine.answer({ quizId: quiz.quizId, questionId: 'q1', choiceIndex: 0 });
    assert.equal(engine.state.quiz.current.id, 'q2');
    await engine.executeTool({ threadId: 'coach', turnId: 'review', callId: 'append', tool: 'append_quiz_questions', arguments: { quizId: quiz.quizId, questionIds: ['q3'] } });
    assert.equal(engine.state.quiz.current.id, 'q2');
    engine.answer({ quizId: quiz.quizId, questionId: 'q2', choiceIndex: 0 });
    assert.equal(engine.state.quiz.current.id, 'q3');
    assert.equal(engine.state.quiz.answered, 3);
    const context = await engine.executeTool({ threadId: 'coach', turnId: 'review', callId: 'stats', tool: 'read_quiz_stats', arguments: { quizId: quiz.quizId } });
    const stats = JSON.parse(context.contentItems[0].text);
    assert.deepEqual(stats.askedQuestions.map(q => q.id), ['q1', 'q2']);
    assert.deepEqual(stats.queuedQuestions.map(q => q.id), ['q3']);
    engine.setMode('programmatic');
    await assert.rejects(engine.executeTool({ threadId: 'coach', turnId: 'review', callId: 'late', tool: 'append_quiz_questions', arguments: { quizId: quiz.quizId, questionIds: ['q3'] } }), /no longer authorized/);
  } finally { engine.shutdown(); }
});

test('older follow-up quiz files resume as ordinary adaptive quizzes', () => {
  const engine = new QuizEngine({ running: false }, () => defaultSettings, process.cwd(), () => {});
  try {
    const restored = engine.restoreFile(JSON.stringify({ version: 1, id: 'saved', title: 'Addition', bankId: 'bank', bank: questions,
      queue: questions.map(q => q.id), answers: [{ submitted: '1', seconds: 3 }], adaptive: true, added: 24, followUpIds: ['q1'] }));
    assert.equal(restored.quiz.current.id, 'q1');
    assert.equal(restored.quiz.stats.correct, 1);
    assert.ok(!('followUpPending' in restored.quiz));
    assert.ok(!('followUpIds' in JSON.parse(engine.exportFile())));
    engine.answer({ quizId: 'saved', questionId: 'q1', choiceIndex: 0 });
    assert.equal(engine.state.quiz.current.id, 'q2');
  } finally { engine.shutdown(); }
});

test('programmatic mode selects easier unused practice offline and preserves the current question', () => {
  const engine = new QuizEngine({ running: false, request: () => { throw new Error('Programmatic mode must not call AI'); } }, () => defaultSettings, process.cwd(), () => {});
  try {
    const bank = engine.createBank({ title: 'Mixed', questions: questions.map((q, i) => ({ ...q, topic: i === 1 ? 'Other' : 'Addition', difficulty: i === 0 ? 2 : 1 })) });
    const quiz = engine.startQuiz({ bankId: bank.bankId, questionIds: ['q0', 'q1'], adaptiveMode: 'programmatic' });
    engine.answer({ quizId: quiz.quizId, questionId: 'q0', choiceIndex: 1 });
    assert.equal(engine.state.quiz.current.id, 'q1');
    assert.deepEqual(JSON.parse(engine.exportFile()).queue, ['q0', 'q1', 'q2', 'q3']);
    assert.equal(engine.state.quiz.total, 4);
    engine.restoreFile(engine.exportFile());
    assert.equal(engine.state.quiz.adaptiveMode, 'programmatic');
    engine.setAdaptive(false);
    engine.answer({ quizId: quiz.quizId, questionId: 'q1', choiceIndex: 1 });
    assert.equal(engine.state.quiz.total, 4);
  } finally { engine.shutdown(); }
});

test('programmatic mode challenges repeated success and avoids stacking same-topic questions', () => {
  const engine = new QuizEngine({ running: false }, () => defaultSettings, process.cwd(), () => {});
  try {
    const bank = engine.createBank({ title: 'Addition', questions: questions.map((q, i) => ({ ...q, difficulty: i >= 2 ? 2 : 1 })) });
    const quiz = engine.startQuiz({ bankId: bank.bankId, questionIds: ['q0', 'q1'], adaptiveMode: 'programmatic' });
    engine.answer({ quizId: quiz.quizId, questionId: 'q0', choiceIndex: 0 });
    assert.equal(engine.state.quiz.total, 4);
    engine.answer({ quizId: quiz.quizId, questionId: 'q1', choiceIndex: 0 });
    assert.equal(engine.state.quiz.current.id, 'q2');
    assert.equal(engine.state.quiz.current.difficulty, 2);
    engine.setMode('programmatic');
    assert.equal(engine.state.quiz.total, 4);
  } finally { engine.shutdown(); }
});

test('coach can consult any indexed page of cited PDFs but cannot read unrelated files', async () => {
  let started;
  const turnStarted = new Promise(resolve => { started = resolve; });
  let initialContext;
  const client = { running: true, request: async (method,args) => {
    if (method === 'thread/start') return { thread: { id: 'source-coach' } };
    if (method === 'turn/start') { initialContext=JSON.parse(args.input[1].text);started(); return { turn: { id: 'review', status: 'inProgress' } }; }
    return {};
  } };
  const documents = [
    { fileId: 'guide', title: 'Study guide', pages: [{ number: 1, text: 'Database fundamentals' }, { number: 36, text: 'BCNF requires every determinant to be a superkey.' }] },
    { fileId: 'unrelated', title: 'Other file', pages: [{ number: 1, text: 'Not quiz material' }] }
  ];
  const engine = new QuizEngine(client, () => defaultSettings, process.cwd(), () => {}, () => documents);
  try {
    const bank = engine.createBank({ title: 'Guide quiz', sourceFileIds: ['guide'], questions: [questions[0]] });
    const quiz = engine.startQuiz({ bankId: bank.bankId });
    engine.answer({ quizId: quiz.quizId, questionId: 'q0', choiceIndex: 0 });
    await turnStarted;
    let n = 0;
    const call = (tool, args) => engine.executeTool({ threadId: 'source-coach', turnId: 'review', callId: String(n++), tool, arguments: { quizId: quiz.quizId, ...args } });
    const stats = initialContext;
    assert.equal(stats.newAnswersSinceReview, 1);
    assert.deepEqual(stats.sourceDocuments[0].suggestedNextPages, [1,36]);
    assert.deepEqual(JSON.parse(engine.exportFile()).sourceFiles, [{fileId:'guide',title:'Study guide'}]);
    assert.deepEqual(stats.sourceDocuments.map(d => d.fileId), ['guide']);
    const source = JSON.parse((await call('read_quiz_source', { fileId: 'guide', page: 36, count: 1 })).contentItems[0].text);
    assert.equal(source.pages[0].page, 36);
    const repeated=JSON.parse((await call('read_quiz_source',{fileId:'guide',page:36,count:1})).contentItems[0].text);
    assert.equal(repeated.pages[0].unchanged,true);assert.equal(repeated.pages[0].text,undefined);
    assert.deepEqual(engine.state.quiz.attachments, [{ fileId: 'guide', name: 'Study guide', available: true, indexedPages: 2, citedPages: [], readPages: [36] }]);
    assert.match(source.pages[0].text, /BCNF/);
    await assert.rejects(call('read_quiz_source', { fileId: 'unrelated' }), /attached PDF/);
    await assert.rejects(call('read_quiz_source', { fileId: 'guide', count: 9 }), /1–8/);
    documents.shift();
    assert.equal(engine.state.quiz.attachments[0].available, false);
    assert.deepEqual(engine.state.quiz.attachments[0].citedPages, []);

  } finally { engine.shutdown(); }
});

test('whole PDF attachments persist even without question page citations', () => {
  const docs=[{fileId:'guide',title:'Whole guide.pdf',pages:[{number:1,text:'Introduction'},{number:36,text:'Normalization'}]}];
  const engine=new QuizEngine({running:false},()=>defaultSettings,process.cwd(),()=>{},()=>docs,()=> 'guide');
  try {
    const bank=engine.createBank({title:'PDF quiz',questions:[questions[0]]});
    engine.startQuiz({bankId:bank.bankId});
    assert.equal(engine.state.quiz.attachments[0].indexedPages,2);
    assert.deepEqual(engine.state.quiz.attachments[0].citedPages,[]);
    const saved=engine.exportFile();docs.length=0;
    engine.restoreFile(saved);
    assert.equal(engine.state.quiz.attachments[0].name,'Whole guide.pdf');
    assert.equal(engine.state.quiz.attachments[0].available,false);
    assert.deepEqual(JSON.parse(engine.exportFile()).sourceFiles,[{fileId:'guide',title:'Whole guide.pdf'}]);
  } finally {engine.shutdown();}
});

test('PDF coverage can exceed twelve additions and stops at one hundred total questions', () => {
  const bank=Array.from({length:101},(_,i)=>({...questions[0],id:`coverage${i}`,prompt:`Coverage question ${i}`}));
  const engine=new QuizEngine({running:false},()=>defaultSettings,process.cwd(),()=>{});
  try {
    engine.restoreFile(JSON.stringify({version:1,id:'coverage',title:'Full PDF',bankId:'coverage-bank',bank,
      sourceFiles:[{fileId:'guide',title:'Guide.pdf'}],queue:bank.slice(0,100).map(q=>q.id),
      answers:Array.from({length:99},()=>({submitted:'1',seconds:1})),adaptive:true,adaptiveMode:'ai',added:95}));
    const stats=engine.executeWorkspaceTool('read_quiz_stats',{});
    assert.equal(stats.adaptiveBudget.additionsLeft,0);
    assert.equal(engine.state.quiz.total,100);
    assert.equal(JSON.parse(engine.exportFile()).added,95);
  } finally {engine.shutdown();}
});

test('AI buffer exposes a protected current question and replaces only future slots atomically', async () => {
  let started;
  const turnStarted=new Promise(resolve=>{started=resolve;});
  const client={running:true,request:async method=>{
    if(method==='thread/start')return {thread:{id:'buffer-coach'}};
    if(method==='turn/start'){started();return {turn:{id:'review',status:'inProgress'}};}
    return {};
  }};
  const bankQuestions=Array.from({length:8},(_,i)=>({...questions[0],id:`b${i}`,prompt:`Buffer question ${i}`}));
  const engine=new QuizEngine(client,()=>defaultSettings,process.cwd(),()=>{});
  let callId=0;
  const call=(tool,args)=>engine.executeTool({threadId:'buffer-coach',turnId:'review',callId:String(callId++),tool,arguments:{quizId:engine.state.quiz.id,...args}});
  try {
    const bank=engine.createBank({title:'Buffer',questions:bankQuestions});
    engine.startQuiz({bankId:bank.bankId,count:3});
    await turnStarted; // A short initial queue proactively starts a review without an answer.
    const stats=JSON.parse((await call('read_quiz_stats',{})).contentItems[0].text);
    assert.equal(stats.buffer.questionsNeeded,1);assert.equal(stats.protectedQuestionId,'b0');
    assert.deepEqual(stats.replaceableQuestionIds,['b1','b2']);
    await call('append_quiz_questions',{questionIds:['b3']});
    await call('replace_quiz_questions',{targetQuestionIds:['b2'],questionIds:['b4']});
    assert.deepEqual(JSON.parse(engine.exportFile()).queue,['b0','b1','b4','b3']);
    engine.answer({quizId:engine.state.quiz.id,questionId:'b0',choiceIndex:0});
    const before=engine.exportFile();
    await assert.rejects(call('replace_quiz_questions',{targetQuestionIds:['b1'],questionIds:['b5']}),/Only future/);
    await assert.rejects(call('replace_quiz_questions',{targetQuestionIds:['b0'],questionIds:['b5']}),/Only future/);
    await assert.rejects(call('append_quiz_questions',{questionIds:['b2']}),/duplicated/);
    assert.equal(engine.exportFile(),before);
    await call('replace_quiz_questions',{targetQuestionIds:['b3'],questionIds:['b5']});
    await assert.rejects(call('replace_quiz_questions',{targetQuestionIds:['b4'],questionIds:['b6']}),/budget/);
    const saved=engine.exportFile();engine.restoreFile(saved);
    assert.deepEqual(JSON.parse(engine.exportFile()).retiredQuestionIds,['b2','b3']);
    assert.equal(engine.state.quiz.current.id,'b1');
    assert.equal(engine.state.quiz.stats.correct,1);
  } finally {engine.shutdown();}
});

test('an explicit question maximum persists without eagerly generating all slots', () => {
  const bankQuestions=Array.from({length:60},(_,i)=>({...questions[0],id:`max${i}`,prompt:`Maximum question ${i}`}));
  const engine=new QuizEngine({running:false},()=>defaultSettings,process.cwd(),()=>{});
  try {
    const bank=engine.createBank({title:'Maximum',questions:bankQuestions});
    engine.startQuiz({bankId:bank.bankId,count:3,adaptiveMode:'programmatic'});
    engine.setMaxQuestions(50);
    assert.equal(engine.state.quiz.maxQuestions,50);
    assert.equal(engine.state.quiz.total,4);
    for(let i=0;i<47;i++)engine.answer({quizId:engine.state.quiz.id,questionId:engine.state.quiz.current.id,choiceIndex:0});
    assert.equal(engine.state.quiz.total,50);
    assert.equal(engine.state.quiz.remaining,3);
    assert.throws(()=>engine.setMaxQuestions(49),/already generated/);
    assert.throws(()=>engine.setMaxQuestions(101),/100/);
    engine.restoreFile(engine.exportFile());
    assert.equal(engine.state.quiz.maxQuestions,50);
    assert.equal(engine.state.quiz.total,50);
  } finally {engine.shutdown();}
});

test('coach continues the same thread within fifteen minutes and rotates after inactivity or a new quiz',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.UTC(2026,9,12,12)});
  const threads=[],turns=[],unsubscribed=[];
  let settle,sawBusy=false;
  const finished=()=>new Promise(resolve=>{settle=resolve;sawBusy=false;});
  const client={running:true,request:async(method,args)=>{
    if(method==='thread/start'){const id=`reuse-${threads.length}`;threads.push({id,args});return {thread:{id}};}
    if(method==='turn/start'){turns.push(args);return {turn:{id:`turn-${turns.length}`,status:'completed'}};}
    if(method==='thread/unsubscribe')unsubscribed.push(args.threadId);
    return {};
  }};
  const engine=new QuizEngine(client,()=>defaultSettings,process.cwd(),event=>{
    if(event.method!=='quiz/state')return;
    if(event.params.state.quiz?.coachBusy)sawBusy=true;
    else if(sawBusy){sawBusy=false;settle?.();}
  });
  try {
    const bank=engine.createBank({title:'Reuse',questions});
    let done=finished();engine.startQuiz({bankId:bank.bankId,count:2});await done;
    const firstId=threads[0].id;
    t.mock.timers.setTime(Date.now()+14*60*1000);
    done=finished();engine.answer({quizId:engine.state.quiz.id,questionId:'q0',choiceIndex:0});await done;
    assert.equal(threads.length,1);assert.equal(turns[1].threadId,firstId);
    const update=JSON.parse(turns[1].input[1].text);assert.equal(update.contextMode,'delta');assert.deepEqual(update.recentAnswers.map(a=>a.questionId),['q0']);assert.equal(update.questionBank,undefined);
    t.mock.timers.setTime(Date.now()+15*60*1000+1);
    done=finished();engine.syncTranscript([{id:'later',role:'user',text:'Can we discuss this question?',final:true,time:Date.now()}]);await done;
    assert.equal(JSON.parse(turns[2].input[1].text).recentDiscussion[0].text,'Can we discuss this question?');
    assert.equal(threads.length,2);assert.notEqual(turns[2].threadId,firstId);assert.ok(unsubscribed.includes(firstId));
    assert.equal(threads[0].args.config.model_auto_compact_token_limit,defaultSettings.compactAtTokens);
    done=finished();engine.startQuiz({bankId:bank.bankId,count:2});await done;
    assert.equal(threads.length,3,'A new quiz must not inherit another quiz’s coach context');
  }finally{engine.shutdown();}
});

test('coach tool context appends only new grades and discussion; compaction resets the snapshot',async()=>{
  let started;const began=new Promise(resolve=>{started=resolve;});const turns=[];
  const client={running:true,request:async(method,args)=>{
    if(method==='thread/start')return {thread:{id:'delta-coach'}};
    if(method==='turn/start'){turns.push(args);started();return {turn:{id:'review',status:'inProgress'}};}
    return {};
  }};
  const engine=new QuizEngine(client,()=>defaultSettings,process.cwd(),()=>{});let callId=0;
  const read=async()=>JSON.parse((await engine.executeTool({threadId:'delta-coach',turnId:'review',callId:String(callId++),tool:'read_quiz_stats',arguments:{quizId:engine.state.quiz.id}})).contentItems[0].text);
  try {
    const spoken={id:'speech',role:'user',text:'I do not understand the first example.',final:true,time:Date.now()};
    engine.syncTranscript([spoken]);
    const bank=engine.createBank({title:'Delta',questions});engine.startQuiz({bankId:bank.bankId,count:3});
    engine.answer({quizId:engine.state.quiz.id,questionId:'q0',choiceIndex:0});await began;
    const first=JSON.parse(turns[0].input[1].text);assert.equal(first.contextMode,'snapshot');assert.equal(first.recentAnswers.length,1);
    assert.equal(first.recentDiscussion[0].text,spoken.text,'Transcript must arrive automatically in the review input');
    const unchanged=await read();assert.equal(unchanged.recentDiscussion,undefined);assert.equal(unchanged.recentAnswers,undefined);
    engine.answer({quizId:engine.state.quiz.id,questionId:'q1',choiceIndex:0});
    engine.syncTranscript([{...spoken,text:spoken.text+' Why does adding one work?'}]);
    const delta=await read();assert.equal(delta.contextMode,'delta');assert.equal(delta.questionBank,undefined);
    assert.deepEqual(delta.recentAnswers.map(a=>a.questionId),['q1']);
    assert.equal(delta.recentDiscussion[0].text,' Why does adding one work?');
    engine.notification({method:'item/completed',params:{threadId:'delta-coach',item:{type:'contextCompaction'}}});
    const reset=await read();assert.equal(reset.contextMode,'snapshot');assert.equal(reset.recentAnswers.length,2);
  }finally{engine.shutdown();}
});
