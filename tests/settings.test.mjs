import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSettings } from '../dist/main/main/settings.js';
import { defaultSettings } from '../dist/main/shared.js';

test('missing settings use the saved default preset', () => {
  assert.deepEqual(cleanSettings({}), defaultSettings);
});

test('old settings preserve selected values and seed independent quiz settings', () => {
  const saved={...defaultSettings,model:'custom-answer',reasoningEffort:'high',priority:true,lowPowerMode:false,agentTools:false,bridgeResearch:false};
  delete saved.quizModel;delete saved.quizReasoningEffort;
  const migrated=cleanSettings(saved);
  assert.equal(migrated.quizModel,'custom-answer');assert.equal(migrated.quizReasoningEffort,'high');
  assert.deepEqual(migrated,{...saved,quizModel:'custom-answer',quizReasoningEffort:'high'});
  const split=cleanSettings({...migrated,quizModel:'custom-quiz',quizReasoningEffort:'low'});
  assert.equal(split.model,'custom-answer');assert.equal(split.reasoningEffort,'high');
  assert.equal(split.quizModel,'custom-quiz');assert.equal(split.quizReasoningEffort,'low');
  assert.equal(cleanSettings({...split,quizModel:''}).quizModel,'');
});

test('invalid generator settings are rejected or normalized', () => {
  assert.throws(()=>cleanSettings({quizModel:42}),/Invalid input/);
  assert.equal(cleanSettings({quizReasoningEffort:'invalid'}).quizReasoningEffort,defaultSettings.quizReasoningEffort);
});

test('sidebar file preference survives saving and old display preferences remain valid', () => {
  for(const demoPlacement of ['side','popup','file']) {
    const saved=cleanSettings({demoPlacement});
    assert.equal(cleanSettings(JSON.parse(JSON.stringify(saved))).demoPlacement,demoPlacement);
  }
  assert.equal(cleanSettings({demoPlacement:'invalid'}).demoPlacement,defaultSettings.demoPlacement);
});
