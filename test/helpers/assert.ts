/**
 * Narrows away the optionality the fakes and the model expose. Substituting a default instead
 * lets a test carry on against a stand-in value, which turns a missing thing into a confusing
 * failure somewhere further down — or into a pass.
 */
export function must<T>(value: T, what: string): NonNullable<T> {
  if (value === undefined || value === null) {
    throw new Error(`the test expected ${what} to exist`);
  }
  return value;
}
