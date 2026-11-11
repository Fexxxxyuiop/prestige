
import secrets
from decimal import Decimal

from fastapi import FastAPI, Depends, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from backend.config import settings
from backend.database import Base, engine, get_session
from backend.models import (
    User,
    Listing,
    Order,
    SupportTicket,
    AdminAudit,
    ListingStatus,
    OrderStatus,
)
from backend.security import current_user


app = FastAPI(
    title="Prestige Market API",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# -------------------------
# DATABASE
# -------------------------

@app.on_event("startup")
async def startup():
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)


@app.get("/")
async def root():
    return {
        "ok": True,
        "service": "Prestige Market API",
    }


@app.get("/health")
async def health():
    return {"status": "ok"}


# -------------------------
# SCHEMAS
# -------------------------

class ListingCreate(BaseModel):
    category: str = "nft"
    title: str = Field(min_length=1, max_length=200)
    description: str = ""
    image_url: str | None = None
    external_url: str | None = None
    price: Decimal | None = None
    price_per_day: Decimal | None = None
    min_days: int = Field(default=1, ge=1, le=365)
    max_days: int = Field(default=30, ge=1, le=365)


class ListingUpdate(BaseModel):
    category: str | None = None
    title: str | None = None
    description: str | None = None
    image_url: str | None = None
    external_url: str | None = None
    price: Decimal | None = None
    price_per_day: Decimal | None = None
    min_days: int | None = None
    max_days: int | None = None
    available: bool | None = None
    status: ListingStatus | None = None


class OrderCreate(BaseModel):
    kind: str = "rental"
    listing_id: int | None = None
    quantity: int = Field(default=1, ge=1, le=100)
    days: int | None = Field(default=None, ge=1, le=365)
    description: str = ""


class SupportCreate(BaseModel):
    subject: str = Field(min_length=1, max_length=200)
    message: str = Field(min_length=1, max_length=5000)


# -------------------------
# HELPERS
# -------------------------

def listing_dict(item: Listing):
    price = float(item.price_per_day or 0)

    return {
        "id": item.id,
        "category": item.category,
        "title": item.title,
        "description": item.description,
        "image_url": item.image_url,
        "external_url": item.external_url,
        "price": price,
        "price_per_day": price,
        "min_days": item.min_days,
        "max_days": item.max_days,
        "available": item.available,
        "status": item.status.value,
        "owner_telegram_id": item.owner_telegram_id,
        "created_at": item.created_at.isoformat()
        if item.created_at else None,
    }


async def save_user(
    telegram_user: dict,
    session: AsyncSession,
):
    telegram_id = telegram_user["id"]

    result = await session.execute(
        select(User).where(User.telegram_id == telegram_id)
    )
    user = result.scalar_one_or_none()

    if user is None:
        user = User(
            telegram_id=telegram_id,
            username=telegram_user.get("username"),
            first_name=telegram_user.get("first_name"),
        )
        session.add(user)
    else:
        user.username = telegram_user.get("username")
        user.first_name = telegram_user.get("first_name")

    await session.commit()
    return user


def check_admin(telegram_user: dict):
    if telegram_user["id"] not in settings.admins:
        raise HTTPException(
            status_code=403,
            detail="Administrator access required",
        )


async def audit(
    session: AsyncSession,
    admin_id: int,
    action: str,
    target_id: str,
):
    session.add(
        AdminAudit(
            admin_telegram_id=admin_id,
            action=action,
            target_type="listing",
            target_id=target_id,
            details="",
        )
    )


# -------------------------
# USER
# -------------------------

@app.get("/api/me")
async def get_me(
    telegram_user: dict = Depends(current_user),
    session: AsyncSession = Depends(get_session),
):
    user = await save_user(telegram_user, session)

    return {
        "id": user.telegram_id,
        "telegram_id": user.telegram_id,
        "username": user.username,
        "first_name": user.first_name,
        "is_admin": user.telegram_id in settings.admins,
    }


# -------------------------
# CATALOG
# -------------------------

@app.get("/api/listings")
async def get_listings(
    category: str | None = None,
    search: str | None = None,
    session: AsyncSession = Depends(get_session),
):
    query = select(Listing).where(
        Listing.status == ListingStatus.APPROVED,
        Listing.available.is_(True),
    )

    if category and category.lower() != "all":
        query = query.where(Listing.category == category)

    if search:
        query = query.where(
            Listing.title.ilike(f"%{search}%")
        )

    query = query.order_by(Listing.created_at.desc())

    result = await session.execute(query)
    items = result.scalars().all()

    return [listing_dict(item) for item in items]


@app.get("/api/listings/{listing_id}")
async def get_listing(
    listing_id: int,
    session: AsyncSession = Depends(get_session),
):
    result = await session.execute(
        select(Listing).where(
            Listing.id == listing_id,
            Listing.status == ListingStatus.APPROVED,
            Listing.available.is_(True),
        )
    )
    item = result.scalar_one_or_none()

    if item is None:
        raise HTTPException(404, "Listing not found")

    return listing_dict(item)


# -------------------------
# ORDERS
# -------------------------

@app.post("/api/orders")
async def create_order(
    data: OrderCreate,
    telegram_user: dict = Depends(current_user),
    session: AsyncSession = Depends(get_session),
):
    await save_user(telegram_user, session)

    amount = Decimal("0")
    listing = None

    if data.listing_id is not None:
        result = await session.execute(
            select(Listing).where(
                Listing.id == data.listing_id,
                Listing.status == ListingStatus.APPROVED,
                Listing.available.is_(True),
            )
        )
        listing = result.scalar_one_or_none()

        if listing is None:
            raise HTTPException(404, "Listing not found")

        if data.days is None:
            raise HTTPException(400, "Rental days required")

        if not listing.min_days <= data.days <= listing.max_days:
            raise HTTPException(400, "Invalid rental period")

        amount = (
            Decimal(str(listing.price_per_day))
            * data.days
            * data.quantity
        )

    order = Order(
        public_id=secrets.token_urlsafe(8),
        telegram_id=telegram_user["id"],
        kind=data.kind,
        listing_id=data.listing_id,
        quantity=data.quantity,
        days=data.days,
        amount=amount,
        currency="XTR",
        status=OrderStatus.PENDING_MANUAL,
        description=data.description,
    )

    session.add(order)
    await session.commit()
    await session.refresh(order)

    return {
        "ok": True,
        "order_id": order.id,
        "public_id": order.public_id,
        "amount": float(order.amount),
        "status": order.status.value,
    }


# -------------------------
# MY ORDERS
# -------------------------

@app.get("/api/orders")
async def get_my_orders(
    telegram_user: dict = Depends(current_user),
    session: AsyncSession = Depends(get_session),
):
    result = await session.execute(
        select(Order)
        .where(Order.telegram_id == telegram_user["id"])
        .order_by(Order.created_at.desc())
    )

    orders = result.scalars().all()

    return [
        {
            "id": order.id,
            "public_id": order.public_id,
            "kind": order.kind,
            "listing_id": order.listing_id,
            "quantity": order.quantity,
            "days": order.days,
            "amount": float(order.amount),
            "currency": order.currency,
            "status": order.status.value,
            "description": order.description,
            "created_at": order.created_at.isoformat()
            if order.created_at else None,
        }
        for order in orders
    ]


# -------------------------
# SUPPORT
# -------------------------

@app.post("/api/support")
async def create_support_ticket(
    data: SupportCreate,
    telegram_user: dict = Depends(current_user),
    session: AsyncSession = Depends(get_session),
):
    ticket = SupportTicket(
        telegram_id=telegram_user["id"],
        subject=data.subject,
        message=data.message,
    )

    session.add(ticket)
    await session.commit()
    await session.refresh(ticket)

    return {
        "ok": True,
        "ticket_id": ticket.id,
    }


# -------------------------
# ADMIN CATALOG
# -------------------------

@app.get("/api/admin/listings")
async def admin_get_listings(
    telegram_user: dict = Depends(current_user),
    session: AsyncSession = Depends(get_session),
):
    check_admin(telegram_user)

    result = await session.execute(
        select(Listing).order_by(Listing.created_at.desc())
    )

    return [
        listing_dict(item)
        for item in result.scalars().all()
    ]


@app.post("/api/admin/listings")
async def admin_create_listing(
    data: ListingCreate,
    telegram_user: dict = Depends(current_user),
    session: AsyncSession = Depends(get_session),
):
    check_admin(telegram_user)

    price = data.price_per_day
    if price is None:
        price = data.price

    if price is None or price < 0:
        raise HTTPException(400, "Invalid price")

    if data.max_days < data.min_days:
        raise HTTPException(400, "Invalid rental period")

    item = Listing(
        category=data.category,
        title=data.title,
        description=data.description,
        image_url=data.image_url,
        external_url=data.external_url,
        price_per_day=price,
        min_days=data.min_days,
        max_days=data.max_days,
        available=True,
        status=ListingStatus.APPROVED,
        owner_telegram_id=telegram_user["id"],
    )

    session.add(item)
    await session.flush()

    await audit(
        session,
        telegram_user["id"],
        "create_listing",
        str(item.id),
    )

    await session.commit()
    await session.refresh(item)

    return {
        "ok": True,
        "listing": listing_dict(item),
    }


@app.patch("/api/admin/listings/{listing_id}")
async def admin_update_listing(
    listing_id: int,
    data: ListingUpdate,
    telegram_user: dict = Depends(current_user),
    session: AsyncSession = Depends(get_session),
):
    check_admin(telegram_user)

    result = await session.execute(
        select(Listing).where(Listing.id == listing_id)
    )
    item = result.scalar_one_or_none()

    if item is None:
        raise HTTPException(404, "Listing not found")

    updates = data.model_dump(exclude_unset=True)

    if "price" in updates:
        updates["price_per_day"] = updates.pop("price")

    for key, value in updates.items():
        setattr(item, key, value)

    await audit(
        session,
        telegram_user["id"],
        "update_listing",
        str(item.id),
    )

    await session.commit()
    await session.refresh(item)

    return {
        "ok": True,
        "listing": listing_dict(item),
    }


@app.delete("/api/admin/listings/{listing_id}")
async def admin_delete_listing(
    listing_id: int,
    telegram_user: dict = Depends(current_user),
    session: AsyncSession = Depends(get_session),
):
    check_admin(telegram_user)

    result = await session.execute(
        select(Listing).where(Listing.id == listing_id)
    )
    item = result.scalar_one_or_none()

    if item is None:
        raise HTTPException(404, "Listing not found")

    await audit(
        session,
        telegram_user["id"],
        "delete_listing",
        str(item.id),
    )

    await session.delete(item)
    await session.commit()

    return {"ok": True, "deleted": listing_id}
