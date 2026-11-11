"""URL slugs for task titles."""
import re

_NON_WORD = re.compile(r"[^a-z0-9]+")


def slugify(title, max_length=60):
    """Lowercase the title and join words with hyphens."""
    slug = _NON_WORD.sub("-", title.lower()).strip("-")
    return slug[:max_length].rstrip("-")
