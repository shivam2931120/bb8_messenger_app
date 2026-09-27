#!/usr/bin/env python3
"""
Database initialization script for BB84 Chat
This script creates all necessary database tables.
"""

import os
from app import app, db, migrate_database_schema

def init_database():
    """Initialize the database tables"""
    with app.app_context():
        print("Creating database tables...")
        db.create_all()
        if not migrate_database_schema():
            raise RuntimeError("Database schema reconciliation failed")
        print("✓ Database tables created successfully!")
        
        # Print database info
        db_url = app.config['SQLALCHEMY_DATABASE_URI']
        if 'postgresql' in db_url:
            print(f"✓ Using PostgreSQL database")
        else:
            print(f"✓ Using SQLite database (local development)")

if __name__ == "__main__":
    init_database()
