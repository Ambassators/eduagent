import {test} from 'node:test';
import assert from 'node:assert/strict';
import {QuizCoachContext} from '../src/main/quiz-coach-context.ts';
const initial=()=>({quizId:'quiz',stats:{answered:1,correct:1,topics:[{topic:'Keys',answered:1,correct:1}]},usedQuestionIds:['q0','q1'],
  askedQuestions:[{id:'q0',prompt:'First question'}],recentAnswers:[{questionId:'q0',submitted:'A'}],queuedQuestions:[{id:'q1',prompt:'Next question'}],questionBank:[{id:'q2',prompt:'Unused question',explanation:'Reason'}],
  recentDiscussion:[{id:'speech',role:'user',text:'Why is that a key?'}],sourceDocuments:[{fileId:'guide',title:'Guide.pdf',askedPages:[1],queuedPages:[2],pageOverview:[{page:1,preview:'Introduction'},{page:2,preview:'Keys'}]}],
  protectedQuestionId:'q1',remaining:1,buffer:{questionsNeeded:3},adaptiveBudget:{perTurn:3}});
test('unchanged context is not repeated, while fresh grades and transcript suffixes are sent',()=>{
  const context=new QuizCoachContext(),first=initial();assert.equal(context.update(first).contextMode,'snapshot');
  const unchanged=context.update(first);
  for(const field of ['questionBank','sourceDocuments','recentAnswers','recentDiscussion','askedQuestions','stats','usedQuestionIds'])assert.equal(unchanged[field],undefined,field);
  assert.equal(unchanged.protectedQuestionId,'q1');
  const next=initial();next.stats.answered=2;next.stats.topics[0].answered=2;next.usedQuestionIds.push('q2');
  next.recentAnswers.push({questionId:'q1',submitted:'B'});next.askedQuestions.push({id:'q1',prompt:'Next question'});next.queuedQuestions=[{id:'q2',prompt:'Unused question'}];
  next.recentDiscussion[0].text+=' I thought uniqueness was enough.';next.sourceDocuments[0].askedPages=[1,2];
  const delta=context.update(next);
  assert.equal(delta.contextMode,'delta');assert.equal(delta.questionBank,undefined);
  assert.deepEqual(delta.recentAnswers,[{questionId:'q1',submitted:'B'}]);assert.deepEqual(delta.usedQuestionIds,['q2']);
  assert.deepEqual(delta.removedQueuedQuestionIds,['q1']);assert.equal(delta.sourceDocuments[0].pageOverview,undefined);
  assert.equal(delta.recentDiscussion[0].text,' I thought uniqueness was enough.');assert.equal(delta.recentDiscussion[0].update,'append');
});
test('thread reset restores a full snapshot and allows unchanged PDF pages to be read again',()=>{
  const context=new QuizCoachContext();context.update(initial());
  assert.equal(context.page('guide',1,'Page text'),false);assert.equal(context.page('guide',1,'Page text'),true);
  assert.equal(context.page('guide',1,'Edited page text'),false);context.reset();
  assert.equal(context.page('guide',1,'Edited page text'),false);assert.equal(context.update(initial()).contextMode,'snapshot');
});
test('closing and reopening an attachment restores its metadata instead of leaving it removed',()=>{
  const context=new QuizCoachContext();context.update(initial());
  const closed=initial();closed.sourceDocuments=[];
  assert.deepEqual(context.update(closed).removedSourceFileIds,['guide']);
  assert.equal(context.update(initial()).sourceDocuments[0].title,'Guide.pdf');
});
