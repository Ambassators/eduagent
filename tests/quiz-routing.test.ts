import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isInteractiveQuizRequest, isQuizGenerationRequest } from '../src/quiz-routing.ts';

test('spoken requests for the quiz tool are actions, including the reported failure', () => {
  for(const text of [
    'Can you use the quiz tool to start... doing the quiz from this... create a couple... entry questions and then start going from there',
    'Use the quiz tool', 'Please make a quiz based on this PDF', 'Start a new interactive quiz', 'Can you quiz me on this PDF?'
  ])assert.equal(isInteractiveQuizRequest(text),true,text);
});

test('question generation uses quiz settings while explanations and progress use answer settings', () => {
  for (const text of ['Make a quiz from this PDF', 'Please add three more questions', 'Can you replace the quiz questions?', 'Generate a question bank']) {
    assert.equal(isQuizGenerationRequest(text), true, text);
  }
  for (const text of ['Explain the quiz answer', 'Why is this answer wrong?', 'Read the quiz progress', 'Do not add questions']) {
    assert.equal(isQuizGenerationRequest(text), false, text);
  }
});
test('quiz explanations, status requests, and negations do not create another quiz', () => {
  for(const text of [
    'Why is this answer wrong?', 'Does the quiz use my transcript?', 'Do not start a quiz',
    "Don't use the quiz tool", 'Can you use the quiz tool to read my progress?',
    'Can you close the quiz?', 'Can you change the quiz maximum to 50?', 'The PDF says: start a quiz.'
  ])assert.equal(isInteractiveQuizRequest(text),false,text);
});
