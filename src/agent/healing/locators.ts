import ts from 'typescript';
import type { LocatorSpec } from './types';

/**
 * A single-quoted string literal (the page objects' style). Built from the
 * JSON.stringify escaping, so no input can end the literal early.
 */
export function quote(value: string): string {
  const body = JSON.stringify(value).slice(1, -1);
  return `'${body.replace(/\\(.)|'/g, (match, escaped: string | undefined) => (escaped === undefined ? "\\'" : escaped === '"' ? '"' : match))}'`;
}

/** Render a proposed locator as a Playwright call (without receiver). */
export function renderLocator(spec: LocatorSpec): string {
  switch (spec.by) {
    case 'role':
      return `getByRole(${quote(spec.role)}, { name: ${quote(spec.name)}${spec.exact ? ', exact: true' : ''} })`;
    case 'label':
      return `getByLabel(${quote(spec.text)}${spec.exact ? ', { exact: true }' : ''})`;
    case 'text':
      return `getByText(${quote(spec.text)}${spec.exact ? ', { exact: true }' : ''})`;
  }
}

/** Compare locator text from source with Playwright's printed form (quotes and spacing differ). */
export function normalizeLocator(text: string): string {
  return text.replace(/"/g, "'").replace(/\s+/g, ' ').replace(/\(\s/g, '(').replace(/\s\)/g, ')').trim();
}

export interface MemberLocator {
  /** Character range of the assigned expression. */
  start: number;
  end: number;
  /** Full expression, e.g. form.getByRole('button', { name: 'Add note' }) */
  expression: string;
  /** Receiver of the final getBy* call, e.g. form */
  receiver: string;
  /** The final call, e.g. getByRole('button', { name: 'Add note' }) */
  call: string;
  method: string;
  /** Role of a getByRole locator, if statically known. */
  role?: string;
}

const GET_BY = /^getBy(Role|Label|Text|TestId|Placeholder|AltText|Title)$/;

/**
 * Find `this.<member> = <receiver>.getByX(...)` in the constructor of
 * `className`. Only that shape can be repaired automatically: chains that end
 * in filter(), first() and similar are left to a person.
 */
export function findMemberLocator(source: string, className: string, member: string): MemberLocator | { error: string } {
  const sf = ts.createSourceFile('po.ts', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const cls = sf.statements.find((s): s is ts.ClassDeclaration => ts.isClassDeclaration(s) && s.name?.text === className);
  if (!cls) return { error: `class ${className} not found` };
  const ctor = cls.members.find((m): m is ts.ConstructorDeclaration => ts.isConstructorDeclaration(m));
  if (!ctor?.body) return { error: `${className} has no constructor` };
  const assignments = ctor.body.statements.filter(
    (st): st is ts.ExpressionStatement =>
      ts.isExpressionStatement(st) &&
      ts.isBinaryExpression(st.expression) &&
      st.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(st.expression.left) &&
      st.expression.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
      st.expression.left.name.text === member,
  );
  if (assignments.length !== 1) return { error: `${className}.${member} is not assigned exactly once in the constructor` };
  const expr = (assignments[0].expression as ts.BinaryExpression).right;
  if (!ts.isCallExpression(expr) || !ts.isPropertyAccessExpression(expr.expression) || !GET_BY.test(expr.expression.name.text)) {
    return { error: `${className}.${member} is not a plain getBy* locator; repair it by hand` };
  }
  const callee = expr.expression;
  const first = expr.arguments[0];
  return {
    start: expr.getStart(sf),
    end: expr.getEnd(),
    expression: expr.getText(sf),
    receiver: callee.expression.getText(sf),
    call: source.slice(callee.name.getStart(sf), expr.getEnd()),
    method: callee.name.text,
    role: callee.name.text === 'getByRole' && first && ts.isStringLiteral(first) ? first.text : undefined,
  };
}

/** Replace the member's final getBy* call, keeping its receiver (and therefore its scope). */
export function applyLocatorChange(source: string, className: string, member: string, spec: LocatorSpec): { source: string; before: string; after: string } | { error: string } {
  const found = findMemberLocator(source, className, member);
  if ('error' in found) return found;
  const after = `${found.receiver}.${renderLocator(spec)}`;
  if (normalizeLocator(after) === normalizeLocator(found.expression)) return { error: 'the proposed locator is identical to the current one' };
  return { source: source.slice(0, found.start) + after + source.slice(found.end), before: found.expression, after };
}

const FORM_ROLES = ['textbox', 'checkbox', 'combobox', 'radio', 'spinbutton', 'searchbox', 'slider', 'switch'];
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Does the accessibility snapshot taken at the failure show an element the
 * proposed locator would match? This is what "evidence supports the same
 * intended element" means in practice: no snapshot match, no repair.
 */
export function snapshotSupports(spec: LocatorSpec, snapshot: string): { ok: boolean; detail: string } {
  const lines = snapshot.split('\n');
  const quoted = (name: string, exact: boolean) => (exact ? `"${escape(name)}"` : `"[^"]*${escape(name)}[^"]*"`);
  let re: RegExp;
  switch (spec.by) {
    case 'role':
      re = new RegExp(`^\\s*- ${spec.role} ${quoted(spec.name, spec.exact)}`);
      break;
    case 'label':
      re = new RegExp(`^\\s*- (${FORM_ROLES.join('|')}) ${quoted(spec.text, spec.exact)}`);
      break;
    case 'text':
      re = spec.exact ? new RegExp(`(: |text: |")${escape(spec.text)}("|$)`) : new RegExp(escape(spec.text));
      break;
  }
  const hit = lines.find((l) => re.test(l));
  return hit ? { ok: true, detail: `snapshot shows: ${hit.trim()}` } : { ok: false, detail: `no element in the page snapshot matches ${renderLocator(spec)}` };
}
