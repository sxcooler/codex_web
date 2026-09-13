import {Component,lazy,memo,Suspense,type ReactNode} from 'react';
const MarkdownCore=lazy(()=>import('./Markdown.tsx').then(module=>({default:module.Markdown})));
type Props={text:string;streaming?:boolean;resolveUrl?:(url:string)=>string;linkScope?:string;onLink?:(url:string)=>boolean};
class MarkdownBoundary extends Component<{text:string;children:ReactNode},{failed:boolean}>{
 state={failed:false};
 static getDerivedStateFromError(){return {failed:true};}
 render(){return this.state.failed?<div className="prose">{this.props.text}</div>:this.props.children;}
}
export const MarkdownView=memo(function MarkdownView(props:Props){return <MarkdownBoundary text={props.text}><Suspense fallback={<div className="prose">{props.text}</div>}><MarkdownCore {...props}/></Suspense></MarkdownBoundary>;});
