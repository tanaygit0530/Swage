"""Domain models."""
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum


class Priority(Enum):
    LOW = 1
    NORMAL = 2
    HIGH = 3
    URGENT = 4


@dataclass
class User:
    id: int
    username: str
    email: str
    password_hash: str


@dataclass
class Task:
    id: int
    title: str
    description: str = ""
    priority: Priority = Priority.NORMAL
    due: datetime | None = None
    assignee_id: int | None = None
    done: bool = False
    tags: list[str] = field(default_factory=list)
