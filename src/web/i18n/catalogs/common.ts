import type {MessageSchema} from '../types.ts';
const plural=new Intl.PluralRules('en');
export const zh={
 'common.cancel':'取消','common.close':'关闭','common.save':'保存','common.retry':'重试','common.refresh':'刷新','common.refreshing':'刷新中…','common.loading':'读取中…','common.unknown':'未知','common.unknownError':'发生未知错误。',
 'common.errorDetail':(detail:string)=>`操作失败：${detail}`,
 'common.items':(count:number)=>`${count} 项`,
 'locale.label':'界面语言','locale.system':'跟随浏览器','locale.unsaved':'语言偏好未保存，仅当前标签页有效。','locale.retry':'重试保存',
 'api.read.timeout':'读取超时，未能在限定时间内取得完整响应，请重试。',
 'api.submit.timeout':'等待服务器响应超时，提交结果待核实。请先核对历史，不要重复发送。',
 'api.read.disconnected':'无法连接服务器，请检查网络并确认开发机和服务在线。',
 'api.submit.disconnected':'连接中断，提交结果待核实。请先核对历史，不要重复发送。',
 'api.read.invalidJson':(status:string)=>`服务器响应不完整或不是有效的 JSON${status}。请重新同步；若持续失败，请检查服务状态。`,
 'api.submit.invalidJson':(status:string)=>`服务器响应不完整或不是有效的 JSON${status}。提交结果待核实。请先核对历史，不要重复发送。`,
 'api.http.failed':(status:number)=>`请求失败 (${status})`,
 'error.auth.invalid':'密码不正确，请重试。','error.auth.required':'登录已失效，请重新登录。','error.auth.rateLimited':'密码尝试过多，请稍后重试。','error.auth.busy':'密码验证服务繁忙，请稍后重试。','error.request.forbidden':'此请求不被允许。','error.request.invalid':'请求参数不合法，请检查输入。','error.route.missing':'此接口不存在，请检查版本或重新同步。','error.internal':'服务器内部错误，请检查服务状态。','error.thread.busy':'会话正在执行任务，请等待任务结束。',
} as const;
export const en={
 'common.cancel':'Cancel','common.close':'Close','common.save':'Save','common.retry':'Retry','common.refresh':'Refresh','common.refreshing':'Refreshing…','common.loading':'Loading…','common.unknown':'Unknown','common.unknownError':'An unknown error occurred.',
 'common.errorDetail':(detail:string)=>`Operation failed: ${detail}`,
 'common.items':(count:number)=>`${count} ${plural.select(count)==='one'?'item':'items'}`,
 'locale.label':'Interface language','locale.system':'Browser language','locale.unsaved':'Language preference was not saved. It applies only to this tab.','locale.retry':'Retry saving',
 'api.read.timeout':'The read timed out before a complete response arrived. Please retry.',
 'api.submit.timeout':'The server response timed out. The submission result is unconfirmed. Check history before sending again.',
 'api.read.disconnected':'Cannot connect to the server. Check the network and make sure the host and service are online.',
 'api.submit.disconnected':'The connection was interrupted. The submission result is unconfirmed. Check history before sending again.',
 'api.read.invalidJson':(status:string)=>`The server response is incomplete or is not valid JSON${status}. Resync. If this continues, check the service.`,
 'api.submit.invalidJson':(status:string)=>`The server response is incomplete or is not valid JSON${status}. The submission result is unconfirmed. Check history before sending again.`,
 'api.http.failed':(status:number)=>`Request failed (${status})`,
 'error.auth.invalid':'Incorrect password. Please retry.','error.auth.required':'Your login has expired. Please sign in again.','error.auth.rateLimited':'Too many password attempts. Please try again later.','error.auth.busy':'Password verification is busy. Please try again later.','error.request.forbidden':'This request is not allowed.','error.request.invalid':'The request parameters are invalid. Check your input.','error.route.missing':'This endpoint does not exist. Check the version or resync.','error.internal':'An internal server error occurred. Check the service.','error.thread.busy':'This conversation is running a task. Wait for it to finish.',
} satisfies MessageSchema<typeof zh>;
