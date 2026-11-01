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


test('spoken auto-mute defaults off, accepts only explicit opt-in, and survives saving', () => {
  assert.equal(defaultSettings.voiceAutoMute, false);
  for (const value of [undefined, false, 'true', 1, null]) {
    assert.equal(cleanSettings({voiceAutoMute:value}).voiceAutoMute, false);
  }
  const saved=cleanSettings({voiceAutoMute:true});
  assert.equal(cleanSettings(JSON.parse(JSON.stringify(saved))).voiceAutoMute, true);
});


test('voice provider settings migrate and retain independent voices without storing API keys', () => {
  const old = {...defaultSettings, voice:'maple'};
  delete old.voiceProvider; delete old.geminiModel; delete old.geminiVoice;
  const migrated=cleanSettings(old);
  assert.equal(migrated.voiceProvider,'codex');
  assert.equal(migrated.voice,'maple');
  const gemini=cleanSettings({...migrated,voiceProvider:'gemini',geminiVoice:'Puck',geminiModel:'gemini-custom-live',geminiApiKey:'secret'});
  assert.equal(gemini.voiceProvider,'gemini');assert.equal(gemini.geminiVoice,'Puck');assert.equal(gemini.voice,'maple');
  assert.equal('geminiApiKey' in gemini,false);
  assert.deepEqual(cleanSettings(JSON.parse(JSON.stringify(gemini))),gemini);
  assert.equal(cleanSettings({voiceProvider:'unknown'}).voiceProvider,'codex');
  assert.equal(cleanSettings({geminiModel:'  '}).geminiModel,defaultSettings.geminiModel);
  assert.throws(()=>cleanSettings({geminiVoice:42}),/Invalid input/);
});


test('Gemini answer provider saves independently from voice, Codex answers, and quizzes',()=>{
 const old={...defaultSettings};delete old.answerProvider;delete old.geminiAnswerModel;
 const migrated=cleanSettings(old);assert.equal(migrated.answerProvider,'codex');
 const saved=cleanSettings({...migrated,answerProvider:'gemini',geminiAnswerModel:'gemini-private-answer'});
 assert.equal(saved.voiceProvider,'codex');assert.equal(saved.model,defaultSettings.model);assert.equal(saved.quizModel,defaultSettings.quizModel);
 assert.deepEqual(cleanSettings(JSON.parse(JSON.stringify(saved))),saved);
 assert.equal(cleanSettings({answerProvider:'unknown'}).answerProvider,'codex');
 assert.equal(cleanSettings({geminiAnswerModel:'  '}).geminiAnswerModel,defaultSettings.geminiAnswerModel);
 assert.throws(()=>cleanSettings({geminiAnswerModel:42}),/Invalid input/);
});
