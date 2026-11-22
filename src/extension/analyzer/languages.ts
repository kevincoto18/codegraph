/**
 * Registry of the supported languages, without their parsers: cheap enough
 * to load when the extension activates (file filters, import resolution).
 */
import { LanguageRegistry } from './language';
import { TYPESCRIPT_LANGUAGE } from './typescriptLanguage';

/** Every built-in language. Add new languages here. */
export const LANGUAGES = new LanguageRegistry([TYPESCRIPT_LANGUAGE]);
