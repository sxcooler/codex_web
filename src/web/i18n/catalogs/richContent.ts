import type {MessageSchema} from '../types.ts';
export const zh={
 'rich.draftTooLong':'内容超出草稿 12000 字符上限，未覆盖现有草稿。',
 'rich.original':'查看原文','rich.copy':'复制原文','rich.copyPending':'复制中…','rich.copyDone':'已复制','rich.copyFailed':'复制失败，请在原文中选择并复制。',
 'rich.invalid':'内容引用格式无效或超过限制。','rich.unsupported':'宿主暂不支持此内容。','rich.unresolved':'来源未解析；缺少可信来源元数据。','rich.pending':'正在接收内容引用…',
 'rich.source':'来源文件','rich.output':'产物文件','rich.fileUnavailable':'无法映射到此会话的文件预览；保留路径供核对。',
 'rich.review':'审查批注','rich.priority':'优先级','rich.confidence':'置信度','rich.writing':'写作草稿','rich.task':'建议任务','rich.draft':'放入草稿','rich.draftReady':'已放入可审阅草稿，尚未发送。','rich.draftUnavailable':'此视图没有草稿入口；请复制内容后使用。',
 'rich.details':'详细内容','rich.template':'产物模板','rich.templateUnavailable':'模板库宿主未接入；此卡不会读取目录或安装技能。','rich.page':'Pages 页面','rich.pageUnavailable':'Pages 宿主未接入；页面身份未解析为公开链接。','rich.receipt':'控制/状态收据（未执行）','rich.memoryReceipt':'记忆收据（原文保留）',
 'rich.toolStructured':'结构化工具结果','rich.toolTruncated':'内容已限制长度；完整收据保留在原始详情。','rich.toolAudio':'工具音频','rich.toolAudioFailed':'无法解码此音频，请查看原始详情。','rich.toolResource':'工具资源','rich.toolResourceUnavailable':'资源宿主或授权读取合同未接入；未打开此 URI。','rich.toolWidget':'工具应用界面','rich.toolWidgetUnavailable':'MCP App/widget 宿主未接入；未执行资源或授予工具权限。','rich.toolUnsupported':'此工具内容暂不支持预览；查看原始详情。','rich.toolImageUnavailable':'此图片引用缺少已授权预览；查看原始详情。',
} as const;
export const en={
 'rich.draftTooLong':'The content exceeds the 12000-character draft limit. Your existing draft was not replaced.',
 'rich.original':'View original','rich.copy':'Copy original','rich.copyPending':'Copying…','rich.copyDone':'Copied','rich.copyFailed':'Copy failed. Select and copy from the original.',
 'rich.invalid':'The content reference is invalid or exceeds its limits.','rich.unsupported':'This host does not support this content.','rich.unresolved':'Source unresolved: trusted source metadata is missing.','rich.pending':'Receiving content reference…',
 'rich.source':'Source file','rich.output':'Output file','rich.fileUnavailable':'Cannot map this path to this conversation’s file preview. The path is preserved for review.',
 'rich.review':'Review comment','rich.priority':'Priority','rich.confidence':'Confidence','rich.writing':'Writing draft','rich.task':'Suggested task','rich.draft':'Use as draft','rich.draftReady':'Added to a reviewable draft. It has not been sent.','rich.draftUnavailable':'This view has no draft composer. Copy the content to use it.',
 'rich.details':'Details','rich.template':'Artifact template','rich.templateUnavailable':'The template gallery host is unavailable. This card does not read directories or install skills.','rich.page':'Pages page','rich.pageUnavailable':'The Pages host is unavailable. Page identity has not been resolved to a public URL.','rich.receipt':'Control/status receipt (not executed)','rich.memoryReceipt':'Memory receipt (original preserved)',
 'rich.toolStructured':'Structured tool result','rich.toolTruncated':'Display length is limited. The complete receipt remains in the original details.','rich.toolAudio':'Tool audio','rich.toolAudioFailed':'This audio could not be decoded. See the original details.','rich.toolResource':'Tool resource','rich.toolResourceUnavailable':'A resource host or authorized reading contract is unavailable. This URI was not opened.','rich.toolWidget':'Tool application UI','rich.toolWidgetUnavailable':'The MCP App/widget host is unavailable. No resource was executed or tool permissions granted.','rich.toolUnsupported':'Preview is unavailable for this tool content. See the original details.','rich.toolImageUnavailable':'This image reference has no authorized preview. See the original details.',
} satisfies MessageSchema<typeof zh>;
