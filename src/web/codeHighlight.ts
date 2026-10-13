import type {CodeHighlighterPlugin} from 'streamdown';

export type HighlightResult=NonNullable<ReturnType<CodeHighlighterPlugin['highlight']>>;
export const plainTokens=(text:string):HighlightResult=>({tokens:text.split('\n').map(content=>[{content}])});
export const checkedTokens=(text:string,result:HighlightResult)=>result.tokens.map(line=>line.map(token=>token.content).join('')).join('\n')===text?result:plainTokens(text);
// ponytail: upstream caches only code edges/length; verify the complete source on every result.
export function checkedHighlighter(nativeCode:CodeHighlighterPlugin):CodeHighlighterPlugin{
 return {...nativeCode,highlight(options,callback){
  const check=(result:HighlightResult)=>checkedTokens(options.code,result);
  const result=nativeCode.highlight(options,callback?value=>callback(check(value)):undefined);
  return result?check(result):null;
 }};
}
