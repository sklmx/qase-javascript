Feature: Cucumber documentation
    As a user of cucumber.js
    I want to have documentation on cucumber
    So I can write better applications

    @sections @Q-1
    Scenario: Usage documentation
        Given I am on the cucumber.js GitHub repository
        When I go to the README file
#        Then I should see a "Cool" section
#        When I go to the README file

    @badges @q2
    Scenario: Status badges
        Given I am on the cucumber.js GitHub repository
        When I go to the README file
        Then I should see a "12412412" badge
            And I should see a "Dependencies" badge

    @ignore @q3
    Scenario: Status badges 2
        Given I am on the cucumber.js GitHub repository
        When I go to the README file
        Then I should see a "Build Status" badge
        And I should see a "Dependencies" badge

    @sections @Q-4
    Scenario: Usage documentation 5
        Given I am on the cucumber.js GitHub repository
        Then I should see nothing
