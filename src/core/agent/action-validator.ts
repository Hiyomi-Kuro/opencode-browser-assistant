import type { ToolCall } from '../../shared/types';
import { validateToolArguments } from './tool-registry';

export function validateAction(action: ToolCall) {
  return validateToolArguments(action.name, action.arguments);
}
