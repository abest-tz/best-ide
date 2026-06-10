#!/bin/bash
# Setup and run the extension in the Development Host environment

echo "--- 1. Installing dependencies ---"
npm install

if [ $? -ne 0 ]; then
    echo "Error installing dependencies. Please check your network or package manager."
    exit 1
fi

echo "--- 2. Building the project ---"
npm run build

if [ $? -ne 0 ]; then
    echo "Error building the project. Check for compilation errors."
    exit 1
fi

echo ""
echo "============================================================="
echo "✅ Build and Install Complete!"
echo "============================================================="
echo "To run this extension in a simulated VS Code environment (Development Host):"
echo "1. Ensure you are running this script from the root of the project."
echo "2. Press F5 in your current VS Code window."
echo ""
echo "The agent core is now built and ready for testing!"