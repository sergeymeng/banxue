import uuid
from datetime import datetime, timezone

from sqlalchemy import JSON, Float, ForeignKey, String, create_engine, event
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker


def uid():
    return uuid.uuid4().hex


def now():
    return datetime.now(timezone.utc).isoformat()


class Base(DeclarativeBase):
    pass


class Teacher(Base):
    __tablename__ = "teachers"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    data: Mapped[dict] = mapped_column(JSON, default=dict)


class Lesson(Base):
    __tablename__ = "lessons"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    teacher_id: Mapped[str] = mapped_column(ForeignKey("teachers.id", ondelete="CASCADE"), index=True)
    data: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[str] = mapped_column(default=now)


class Event(Base):
    __tablename__ = "events"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    lesson_id: Mapped[str] = mapped_column(ForeignKey("lessons.id", ondelete="CASCADE"), index=True)
    data: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[str] = mapped_column(default=now)


class Knowledge(Base):
    __tablename__ = "knowledge"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    teacher_id: Mapped[str] = mapped_column(ForeignKey("teachers.id", ondelete="CASCADE"), index=True)
    data: Mapped[dict] = mapped_column(JSON)


class Document(Base):
    __tablename__ = "documents"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    teacher_id: Mapped[str] = mapped_column(ForeignKey("teachers.id", ondelete="CASCADE"), index=True)
    data: Mapped[dict] = mapped_column(JSON)


class MaterialInk(Base):
    __tablename__ = "material_ink"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    lesson_id: Mapped[str] = mapped_column(ForeignKey("lessons.id", ondelete="CASCADE"), index=True)
    document_id: Mapped[str] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"), index=True)
    page: Mapped[int] = mapped_column()
    data: Mapped[dict] = mapped_column(JSON)


class Usage(Base):
    __tablename__ = "usage"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    lesson_id: Mapped[str] = mapped_column(ForeignKey("lessons.id", ondelete="CASCADE"), index=True)
    charged_gbp: Mapped[float] = mapped_column(Float, default=0)
    data: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[str] = mapped_column(default=now, index=True)


def database(path):
    engine = create_engine(f"sqlite:///{path}", connect_args={"check_same_thread": False})

    @event.listens_for(engine, "connect")
    def pragmas(connection, _):
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA journal_mode=WAL")

    Base.metadata.create_all(engine)
    with engine.begin() as conn:
        conn.exec_driver_sql(
            'CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(document_id UNINDEXED, teacher_id UNINDEXED, page UNINDEXED, heading, content, tokenize="unicode61")'
        )
    return sessionmaker(engine, expire_on_commit=False), engine
