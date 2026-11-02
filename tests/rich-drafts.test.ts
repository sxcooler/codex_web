import assert from 'node:assert/strict';
import test from 'node:test';
import {suggestedDraft} from '../src/web/drafts.ts';
test('rich-content suggestions append to the current draft without sending or losing it',()=>{
 assert.equal(suggestedDraft('Existing','Suggested'),'Existing\n\nSuggested');
 assert.equal(suggestedDraft('','Suggested'),'Suggested');
 for(const value of ['',null,{},'a'.repeat(12001)])assert.equal(suggestedDraft('Existing',value),null);
 assert.equal(suggestedDraft('a'.repeat(11999),'b'),null);
 assert.equal(suggestedDraft('','b'.repeat(12000))?.length,12000);
});
