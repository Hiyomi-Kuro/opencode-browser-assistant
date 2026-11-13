import type { ToolCall } from '../../shared/types';
import { isSafeHttpUrl } from './tool-registry';

export type SafetyAssessment = { decision: 'allow' | 'confirm' | 'deny'; reason: string };
const HIGH_RISK = new Set(['browser.submit', 'browser.download']);
const SENSITIVE_WORDS = /password|passcode|credit.?card|card.?number|cvv|cvc|payment|billing|account.?number|otp|verification.?code/i;
const IRREVERSIBLE_WORDS = /send|publish|post|purchase|buy|checkout|delete|remove|transfer|change password|update account/i;

export function assessAction(action: ToolCall, options: { confirmEveryAction: boolean; targetSensitive?: boolean; agentOwnedTab?: boolean }): SafetyAssessment {
  const url = action.arguments.url;
  if (typeof url === 'string' && !isSafeHttpUrl(url)) return { decision: 'deny', reason: 'Only HTTP and HTTPS URLs are allowed.' };
  const enteredValue = [action.arguments.text, action.arguments.value].filter((value): value is string => typeof value === 'string').join(' ');
  if (options.targetSensitive || SENSITIVE_WORDS.test(enteredValue)) return { decision: 'deny', reason: 'Password, payment, and other sensitive fields cannot be read or filled by the agent.' };
  if (HIGH_RISK.has(action.name)) return { decision: 'confirm', reason: action.name === 'browser.submit' ? 'Submitting a form sends data to the website.' : 'This action downloads a file.' };
  if (action.name === 'browser.close_tab' && !options.agentOwnedTab) return { decision: 'confirm', reason: 'This tab was not created by OpenCode.' };
  if (action.name === 'browser.click' && typeof action.arguments.label === 'string' && IRREVERSIBLE_WORDS.test(action.arguments.label)) return { decision: 'confirm', reason: 'This control may send, publish, purchase, delete, or change account data.' };
  if (options.confirmEveryAction && !['browser.get_page_info', 'browser.get_text', 'browser.get_dom', 'browser.get_links', 'browser.get_forms', 'browser.get_elements', 'browser.extract_markdown', 'browser.extract_table', 'browser.extract_metadata', 'browser.find_text', 'browser.list_tabs', 'browser.wait'].includes(action.name)) return { decision: 'confirm', reason: 'Confirmation before each browser action is enabled.' };
  return { decision: 'allow', reason: 'This action is within the configured browser permissions.' };
}
