// OpenCode 1.18.34 wildcard semantics, with bounded work instead of an unbounded backtracking regex.
export function matches(
  value: string,
  pattern: string,
  budget: { remaining: number },
  exhausted: () => never,
): boolean {
  value = value.replaceAll('\\', '/');
  pattern = pattern.replaceAll('\\', '/');
  const literal = new Map<string, RegExp>();
  const match = (pattern: string): boolean => {
    let input = 0;
    let rule = 0;
    let star = -1;
    let retry = 0;
    while (input < value.length) {
      if (--budget.remaining < 0) {
        exhausted();
      }
      const token = pattern.at(rule);
      let equal = token === value[input];
      if (!equal && token !== undefined && token !== '*' && token !== '?' && process.platform === 'win32') {
        let expression = literal.get(token);
        if (expression === undefined) {
          expression = new RegExp(`^${token.replace(/[.+^${}()|[\]\\]/g, '\\$&')}$`, 'i');
          literal.set(token, expression);
        }
        equal = expression.test(value[input]);
      }
      if (token === '*') {
        star = rule++;
        retry = input;
      } else if (token === '?' || equal) {
        input++;
        rule++;
      } else if (star >= 0) {
        rule = star + 1;
        input = ++retry;
      } else {
        return false;
      }
    }
    while (pattern[rule] === '*') {
      rule++;
    }
    return rule === pattern.length;
  };
  return match(pattern) || (pattern.endsWith(' *') && match(pattern.slice(0, -2)));
}
