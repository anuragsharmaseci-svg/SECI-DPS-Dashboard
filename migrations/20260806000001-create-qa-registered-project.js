"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("qa_registered_project", {
      qa_project_id: {
        type: Sequelize.UUID,
        primaryKey: true,
        defaultValue: Sequelize.UUIDV4,
      },
      project_name: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      project_details: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      rfb_details: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      ca_no: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      bbu_no: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      contractor_name: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      contractor_address: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      mdcc_no: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE,
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE,
      },
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable("qa_registered_project");
  },
};