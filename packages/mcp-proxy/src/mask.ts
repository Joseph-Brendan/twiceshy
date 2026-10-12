/**
 * C20 rule 7: values Twiceshy resolved from `${VAR}` in the config are known
 * secrets. Wherever downstream stderr or failure details are printed, those
 * values are replaced with "[redacted]". Values shorter than six characters
 * are left alone so ordinary text is not hidden.
 */

export const MIN_SECRET_LENGTH = 6;

export const MASKED_VALUE = '[redacted]';

/** Replaces every known secret value in `text`, longest value first. */
export function maskSecretValues(text: string, values: readonly string[]): string {
  const usable = values
    .filter((value) => value.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);
  let output = text;
  for (const value of usable) {
    output = output.split(value).join(MASKED_VALUE);
  }
  return output;
}

/** A reusable masker for one config's resolved environment values. */
export function createSecretMasker(values: readonly string[]): (text: string) => string {
  if (!values.some((value) => value.length >= MIN_SECRET_LENGTH)) {
    return (text) => text;
  }
  return (text) => maskSecretValues(text, values);
}
