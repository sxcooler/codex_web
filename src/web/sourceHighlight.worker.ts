import {code} from '@streamdown/code';
import {checkedHighlighter} from './codeHighlight.ts';

const highlighter=checkedHighlighter(code);
self.onmessage=(event:MessageEvent<{code:string;language:Parameters<typeof code.highlight>[0]['language']}>)=>{
 const options=event.data;
 if(!code.supportsLanguage(options.language)){self.postMessage(null);return;}
 const send=(result:NonNullable<ReturnType<typeof highlighter.highlight>>)=>self.postMessage({tokens:result.tokens});
 const result=highlighter.highlight({...options,themes:['github-dark','github-dark']},send);
 if(result)send(result);
};
