/**
 * src/cards/builtin/register.ts
 * 卡片插件注册入口：App 入口只需 import '@/cards/builtin/register' 一行。
 * v0.5: 统一注册所有内置卡片。
 */
import { cardRegistry } from '../registry';
import { initCardComm } from '../communicateAdapter';
import { chatCardPlugin } from './chatCard.plugin';
import { noteCardPlugin } from './noteCard.plugin';
import { pdfCardPlugin } from './pdfCard.plugin';

cardRegistry.register(chatCardPlugin, noteCardPlugin, pdfCardPlugin);
initCardComm(cardRegistry);
