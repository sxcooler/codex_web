import {createTranslator,msg} from '../src/web/i18n/messages.ts';
const t=createTranslator('en');
t('common.cancel');
msg('common.errorDetail',new Error('raw'));
// @ts-expect-error unknown keys must not compile
t('missing.key');
// @ts-expect-error static messages take no parameters
t('common.cancel','extra');
// @ts-expect-error an error detail requires a string or display error
msg('common.errorDetail',42);
