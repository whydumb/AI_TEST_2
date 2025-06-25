#!/usr/bin/env python3
"""
Test script for the new long-polling Andy API system
"""

import requests
import time
import json
import threading

# Configuration
ANDY_API_URL = "https://mindcraft.riqvip.dev"
# ANDY_API_URL = "http://localhost:3002"  # For local testing

def test_chat_completion():
    """Test the chat completion endpoint"""
    print("🧪 Testing chat completion endpoint...")
    
    payload = {
        "model": "andy-4",
        "messages": [
            {"role": "user", "content": "Hello! Can you tell me a short joke?"}
        ]
    }
    
    try:
        response = requests.post(
            f"{ANDY_API_URL}/api/andy/v1/chat/completions",
            json=payload,
            timeout=60
        )
        
        print(f"Status Code: {response.status_code}")
        
        if response.status_code == 200:
            result = response.json()
            print("✅ Success!")
            print(f"Response: {result['choices'][0]['message']['content']}")
        else:
            print(f"❌ Failed: {response.text}")
            
    except Exception as e:
        print(f"❌ Error: {e}")

def test_pool_status():
    """Test the pool status endpoint"""
    print("\n🧪 Testing pool status endpoint...")
    
    try:
        response = requests.get(f"{ANDY_API_URL}/api/andy/pool_status")
        
        if response.status_code == 200:
            status = response.json()
            print("✅ Pool Status:")
            print(f"  Total hosts: {status['total_hosts']}")
            print(f"  Active hosts: {status['active_hosts']}")
            print(f"  Total models: {status['total_models']}")
            
            if status['hosts']:
                print("  Hosts:")
                for host in status['hosts']:
                    print(f"    - {host['host_id']}: {host['status']} (load: {host['load']})")
        else:
            print(f"❌ Failed: {response.text}")
            
    except Exception as e:
        print(f"❌ Error: {e}")

def simulate_client():
    """Simulate a client polling for work"""
    print("\n🧪 Simulating client work polling...")
    
    # First "join" the pool (simulation)
    host_id = "test-client-123"
    models = ["andy-4", "llama3:8b"]
    
    for i in range(3):  # Poll 3 times
        try:
            payload = {
                "host_id": host_id,
                "models": models,
                "timeout": 5  # Short timeout for testing
            }
            
            print(f"Poll attempt {i+1}...")
            response = requests.post(
                f"{ANDY_API_URL}/api/andy/poll_for_work",
                json=payload,
                timeout=10
            )
            
            if response.status_code == 200:
                work = response.json()
                print(f"✅ Got work: {work}")
            elif response.status_code == 204:
                print("📭 No work available")
            elif response.status_code == 404:
                print("❌ Host not registered")
            else:
                print(f"❌ Unexpected response: {response.status_code}")
                
        except Exception as e:
            print(f"❌ Poll error: {e}")
        
        time.sleep(1)

def main():
    print("🚀 Testing Andy API Long-Polling System")
    print(f"Server: {ANDY_API_URL}")
    print("=" * 50)
    
    # Test pool status first
    test_pool_status()
    
    # Test simulated client polling
    simulate_client()
    
    # Test chat completion
    test_chat_completion()
    
    print("\n✅ Tests completed!")

if __name__ == "__main__":
    main()
