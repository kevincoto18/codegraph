/**
 * Registry of the supported languages, without their parsers: cheap enough
 * to load when the extension activates (file filters, import resolution).
 */
import { CSHARP_LANGUAGE } from './csharpLanguage';
import { GO_LANGUAGE } from './goLanguage';
import { JAVA_LANGUAGE } from './javaLanguage';
import { LanguageRegistry } from './language';
import { PYTHON_LANGUAGE } from './pythonLanguage';
import { TYPESCRIPT_LANGUAGE } from './typescriptLanguage';

/** Every built-in language. Add new languages here. */
export const LANGUAGES = new LanguageRegistry([
  TYPESCRIPT_LANGUAGE,
  PYTHON_LANGUAGE,
  JAVA_LANGUAGE,
  CSHARP_LANGUAGE,
  GO_LANGUAGE,
]);
