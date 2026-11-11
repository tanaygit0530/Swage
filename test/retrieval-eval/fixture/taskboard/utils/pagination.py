"""Pagination helper for list endpoints."""
from dataclasses import dataclass


@dataclass
class Page:
    items: list
    page: int
    per_page: int
    total: int

    @property
    def pages(self):
        return max(1, -(-self.total // self.per_page))


def paginate(items, page=1, per_page=20):
    """Slice a sequence into one page and report the totals."""
    start = (page - 1) * per_page
    return Page(items=list(items[start : start + per_page]), page=page, per_page=per_page, total=len(items))
