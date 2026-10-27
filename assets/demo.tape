# The tape for assets/demo.gif; assets/record-demo.sh sets the scene and runs it.
Set Shell "bash"
Set FontSize 14
Set Width 1000
Set Height 700
Set Padding 18
Set Framerate 8
Set TypingSpeed 45ms
Set Theme "Catppuccin Mocha"

Hide
Type "export PS1='$ ' && clear"
Enter
Show

Type "llm-tests-forge status"
Enter
Sleep 5s

Type "llm-tests-forge review --only cases"
Enter
Sleep 5s
Type "a"
Enter
Sleep 3s
Type "a"
Enter
Sleep 3s

Type "llm-tests-forge status"
Enter
Sleep 3s

Type "llm-tests-forge estimate"
Enter
Sleep 5s

Type "llm-tests-forge report results.json"
Enter
Sleep 4s
