export type Locale='zh-CN'|'en';
export type LocalePreference='system'|Locale;
export type MessageSchema<T>={[K in keyof T]:T[K] extends (...args:infer A)=>string?(...args:A)=>string:string};
export type LocalizedMessage={key:string;args:readonly unknown[]};
export type UiText=string|Error|LocalizedMessage;
export type DisplayArgs<T extends readonly unknown[]>={[K in keyof T]:T[K] extends string?T[K]|Error|LocalizedMessage:T[K]};
export type LocaleState={preference:LocalePreference;locale:Locale;persisted:boolean};
