"""Text helpers."""


def slugify(text):
    return _clean(text).lower()


def _clean(text):
    return text.strip()


normalize = lambda value: slugify(value)
